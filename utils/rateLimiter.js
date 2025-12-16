import { getPool } from './postgresClient.js';
import { originRateLimitPerHour, ipRateLimitPerHour, rateLimitPollInterval } from '../config.js';

// In-memory blocklists (updated by polling)
const state = {
  blockedOrigins: new Set(),      // Origins that have exceeded their rate limit
  blockedIPs: new Set(),          // IPs (with no origin) that have exceeded their rate limit
  originCounts: new Map(),        // origin -> request count this hour
  ipCounts: new Map(),            // ip -> no-origin request count this hour
  lastPollTime: null,
  isPolling: false,
  pollErrors: 0,
  originsLastHourExists: null     // Cache for column existence check
};

// Strip protocol from origin for consistent comparison
function stripProtocol(url) {
  if (!url) return '';
  if (typeof url !== 'string') return '';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Check if an origin looks like a local/test origin (should be treated as "no origin")
function isLocalOrigin(origin) {
  if (!origin || origin === 'unknown') return true;
  const cleaned = stripProtocol(origin).toLowerCase();
  if (!cleaned) return true;
  
  // Treat these as "no origin" for rate limiting purposes
  if (cleaned.includes('localhost')) return true;
  if (cleaned.startsWith('127.0.0.1')) return true;
  if (cleaned.startsWith('0.0.0.0')) return true;
  if (cleaned.startsWith('192.168.')) return true;
  if (cleaned.startsWith('10.')) return true;
  if (cleaned === 'null') return true;
  
  return false;
}

/**
 * Check if origins_last_hour column exists in the database
 */
async function checkOriginsLastHourExists(pool) {
  if (state.originsLastHourExists !== null) {
    return state.originsLastHourExists;
  }

  try {
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name = 'origins_last_hour'
    `);
    
    state.originsLastHourExists = result.rows.length > 0;
    
    if (!state.originsLastHourExists) {
      console.log('⚠️  origins_last_hour column not found - using fallback (origins column)');
      console.log('   Run: node database_scripts/addOriginsLastHourColumn.js for accurate hourly tracking');
    }
    
    return state.originsLastHourExists;
  } catch (error) {
    console.error('⚠️  Could not check for origins_last_hour column:', error.message);
    return false;
  }
}

/**
 * Poll the database for current rate limit data
 * Updates the in-memory blocklists
 */
async function pollRateLimitData() {
  if (state.isPolling) {
    console.log('⏳ Rate limit poll already in progress, skipping...');
    return;
  }

  state.isPolling = true;

  try {
    const pool = await getPool();
    
    // Check which column to use for origin tracking
    const hasOriginsLastHour = await checkOriginsLastHourExists(pool);
    const originColumn = hasOriginsLastHour ? 'origins_last_hour' : 'origins';

    // Query 1: Get origins that have exceeded the limit
    // Aggregate origin counts across all IPs
    const originsQuery = `
      SELECT 
        origin_key as origin,
        SUM((origin_value)::bigint) as total_requests
      FROM ip_table, 
           jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb)) AS x(origin_key, origin_value)
      GROUP BY origin_key
      HAVING SUM((origin_value)::bigint) > $1
    `;
    
    const originsResult = await pool.query(originsQuery, [originRateLimitPerHour]);
    
    // Query 2: Get IPs with no meaningful origin that have exceeded the limit
    // Calculate: requests_last_hour - sum(origin column values) = no-origin requests
    const ipsQuery = `
      SELECT 
        ip,
        requests_last_hour,
        COALESCE(
          (SELECT SUM((value)::bigint) FROM jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb))),
          0
        ) as origin_requests
      FROM ip_table
      WHERE requests_last_hour > $1
    `;
    
    const ipsResult = await pool.query(ipsQuery, [ipRateLimitPerHour]);

    // Update blocked origins
    const newBlockedOrigins = new Set();
    const newOriginCounts = new Map();
    
    for (const row of originsResult.rows) {
      const cleanOrigin = stripProtocol(row.origin);
      if (cleanOrigin && !isLocalOrigin(cleanOrigin)) {
        newBlockedOrigins.add(cleanOrigin);
        newOriginCounts.set(cleanOrigin, parseInt(row.total_requests));
      }
    }

    // Update blocked IPs (only those where no-origin requests exceed limit)
    const newBlockedIPs = new Set();
    const newIpCounts = new Map();
    
    for (const row of ipsResult.rows) {
      const totalRequests = parseInt(row.requests_last_hour);
      const originRequests = parseInt(row.origin_requests);
      const noOriginRequests = totalRequests - originRequests;
      
      // Only block if the no-origin portion exceeds the IP limit
      if (noOriginRequests > ipRateLimitPerHour) {
        newBlockedIPs.add(row.ip);
        newIpCounts.set(row.ip, noOriginRequests);
      }
    }

    // Atomic update of state
    state.blockedOrigins = newBlockedOrigins;
    state.blockedIPs = newBlockedIPs;
    state.originCounts = newOriginCounts;
    state.ipCounts = newIpCounts;
    state.lastPollTime = new Date();
    state.pollErrors = 0;

    // Log if anything is blocked
    if (newBlockedOrigins.size > 0 || newBlockedIPs.size > 0) {
      console.log(`🚦 Rate limit update: ${newBlockedOrigins.size} origins blocked, ${newBlockedIPs.size} IPs blocked`);
      if (newBlockedOrigins.size > 0) {
        console.log(`   Blocked origins: ${[...newBlockedOrigins].join(', ')}`);
      }
      if (newBlockedIPs.size > 0) {
        console.log(`   Blocked IPs: ${[...newBlockedIPs].join(', ')}`);
      }
    }

  } catch (error) {
    state.pollErrors++;
    console.error('❌ Rate limit poll error:', error.message);
    
    // After 3 consecutive errors, log a warning but don't clear blocklists
    // (fail closed - keep blocking known bad actors)
    if (state.pollErrors >= 3) {
      console.error('⚠️  Rate limit polling has failed 3+ times. Blocklists may be stale.');
    }
  } finally {
    state.isPolling = false;
  }
}

/**
 * Check if a request should be rate limited
 * @param {string} ip - The client IP address
 * @param {string} origin - The request origin (may be null/undefined)
 * @returns {object} { limited: boolean, reason: string|null, retryAfter: number|null }
 */
function checkRateLimit(ip, origin) {
  const cleanOrigin = stripProtocol(origin);
  const hasRealOrigin = cleanOrigin && !isLocalOrigin(cleanOrigin);

  // Debug logging to understand rate limit decisions
  console.log(`🔍 Rate limit check: IP=${ip}, origin=${origin || 'none'}, cleanOrigin=${cleanOrigin || 'none'}, hasRealOrigin=${hasRealOrigin}`);
  console.log(`   Blocked IPs: [${[...state.blockedIPs].join(', ')}], Blocked origins: [${[...state.blockedOrigins].join(', ')}]`);

  if (hasRealOrigin) {
    // This is a deployed app - check origin-based limit
    const isBlocked = state.blockedOrigins.has(cleanOrigin);
    console.log(`   Checking ORIGIN path: ${cleanOrigin} blocked=${isBlocked}`);
    if (isBlocked) {
      const count = state.originCounts.get(cleanOrigin) || 0;
      return {
        limited: true,
        reason: `Origin ${cleanOrigin} has exceeded rate limit (${count}/${originRateLimitPerHour} requests/hour)`,
        retryAfter: getSecondsUntilNextHour()
      };
    }
  } else {
    // This is local testing - check IP-based limit
    const isBlocked = state.blockedIPs.has(ip);
    console.log(`   Checking IP path: ${ip} blocked=${isBlocked}`);
    if (isBlocked) {
      const count = state.ipCounts.get(ip) || 0;
      return {
        limited: true,
        reason: `IP ${ip} has exceeded rate limit for non-origin requests (${count}/${ipRateLimitPerHour} requests/hour)`,
        retryAfter: getSecondsUntilNextHour()
      };
    }
  }

  return { limited: false, reason: null, retryAfter: null };
}

/**
 * Calculate seconds until the next hour boundary (when limits reset)
 */
function getSecondsUntilNextHour() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(nextHour.getHours() + 1);
  nextHour.setMinutes(0);
  nextHour.setSeconds(0);
  nextHour.setMilliseconds(0);
  return Math.ceil((nextHour - now) / 1000);
}

/**
 * Build a JSON-RPC rate limit error response
 * @param {*} requestId - The id from the JSON-RPC request (to echo back)
 */
function buildRateLimitResponse(requestId = null) {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: -32005,
      message: "Rate limit exceeded. Please slow down or contact support if you need higher limits."
    }
  };
}

/**
 * Get current rate limiter status (for monitoring endpoints)
 */
function getRateLimitStatus() {
  return {
    blockedOrigins: [...state.blockedOrigins],
    blockedIPs: [...state.blockedIPs],
    originCounts: Object.fromEntries(state.originCounts),
    ipCounts: Object.fromEntries(state.ipCounts),
    lastPollTime: state.lastPollTime?.toISOString() || null,
    pollErrors: state.pollErrors,
    originsLastHourColumnExists: state.originsLastHourExists,
    config: {
      originRateLimitPerHour,
      ipRateLimitPerHour,
      rateLimitPollInterval
    }
  };
}

/**
 * Start the rate limit polling loop
 */
function startRateLimitPolling() {
  console.log(`🚦 Starting rate limit polling (every ${rateLimitPollInterval}s)`);
  console.log(`   Origin limit: ${originRateLimitPerHour} req/hour`);
  console.log(`   IP (no-origin) limit: ${ipRateLimitPerHour} req/hour`);

  // Initial poll
  pollRateLimitData();

  // Set up polling interval
  setInterval(() => {
    pollRateLimitData();
  }, rateLimitPollInterval * 1000);
}

export {
  checkRateLimit,
  buildRateLimitResponse,
  getRateLimitStatus,
  startRateLimitPolling,
  getSecondsUntilNextHour
};
