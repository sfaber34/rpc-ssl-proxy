import { getPool } from './postgresClient.js';
import { 
  originRateLimitPerHour, 
  ipRateLimitPerHour, 
  originRateLimitPerDay,
  ipRateLimitPerDay,
  rateLimitPollInterval 
} from '../config.js';

// In-memory blocklists (updated by polling)
const state = {
  // Hourly sliding window blocklists
  blockedOrigins: new Set(),      // Origins that have exceeded their hourly rate limit
  blockedIPs: new Set(),          // IPs (with no origin) that have exceeded their hourly rate limit
  
  // Origin hourly counts (for sliding window)
  originCurrentHour: new Map(),   // origin -> current hour request count
  originPreviousHour: new Map(),  // origin -> previous hour request count
  originEffective: new Map(),     // origin -> effective request count (weighted)
  
  // IP hourly counts (for sliding window) - no-origin requests only
  ipCurrentHour: new Map(),       // ip -> current hour no-origin request count
  ipPreviousHour: new Map(),      // ip -> previous hour no-origin request count
  ipEffective: new Map(),         // ip -> effective no-origin request count (weighted)
  
  // Daily blocklists
  dailyBlockedOrigins: new Set(), // Origins that have exceeded their daily rate limit  
  dailyBlockedIPs: new Set(),     // IPs that have exceeded their daily rate limit
  originDailyCounts: new Map(),   // origin -> request count today
  ipDailyCounts: new Map(),       // ip -> request count today
  
  lastPollTime: null,
  isPolling: false,
  pollErrors: 0,
  
  // Feature flags (cached from DB schema checks)
  originsLastHourExists: null,
  slidingWindowExists: null,
  dailyLimitExists: null
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
 * Check if sliding window columns exist (requests_previous_hour, origins_previous_hour)
 */
async function checkSlidingWindowExists(pool) {
  if (state.slidingWindowExists !== null) {
    return state.slidingWindowExists;
  }

  try {
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name IN ('requests_previous_hour', 'origins_previous_hour')
    `);
    
    state.slidingWindowExists = result.rows.length === 2;
    
    if (state.slidingWindowExists) {
      console.log('✅ Sliding window columns detected - using sliding window rate limiting');
    } else {
      console.log('⚠️  Sliding window columns not found - using fixed window rate limiting');
      console.log('   Run: node database_scripts/addSlidingWindowColumns.js for smoother rate limiting');
    }
    
    return state.slidingWindowExists;
  } catch (error) {
    console.error('⚠️  Could not check for sliding window columns:', error.message);
    return false;
  }
}

/**
 * Check if daily limit columns exist (requests_today, origins_today)
 */
async function checkDailyLimitExists(pool) {
  if (state.dailyLimitExists !== null) {
    return state.dailyLimitExists;
  }

  try {
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name IN ('requests_today', 'origins_today')
    `);
    
    state.dailyLimitExists = result.rows.length === 2;
    
    if (state.dailyLimitExists) {
      console.log('✅ Daily limit columns detected - daily rate limiting enabled');
    } else {
      console.log('⚠️  Daily limit columns not found - daily rate limiting disabled');
      console.log('   Run: node database_scripts/addDailyLimitColumns.js for daily limits');
    }
    
    return state.dailyLimitExists;
  } catch (error) {
    console.error('⚠️  Could not check for daily limit columns:', error.message);
    return false;
  }
}

/**
 * Calculate the sliding window weight for the previous hour
 * At minute 0, previous hour counts 100% (weight = 1.0)
 * At minute 59, previous hour counts ~1.7% (weight = 0.017)
 */
function getPreviousHourWeight() {
  const now = new Date();
  const minutesIntoHour = now.getMinutes() + (now.getSeconds() / 60);
  return 1 - (minutesIntoHour / 60);
}

/**
 * Poll the database for current rate limit data
 * Updates the in-memory blocklists using sliding window calculation when available
 */
async function pollRateLimitData() {
  if (state.isPolling) {
    console.log('⏳ Rate limit poll already in progress, skipping...');
    return;
  }

  state.isPolling = true;

  try {
    const pool = await getPool();
    
    // Check which features are available
    const hasOriginsLastHour = await checkOriginsLastHourExists(pool);
    const hasSlidingWindow = await checkSlidingWindowExists(pool);
    const hasDailyLimit = await checkDailyLimitExists(pool);
    
    const originColumn = hasOriginsLastHour ? 'origins_last_hour' : 'origins';
    const previousHourWeight = getPreviousHourWeight();

    // =========================================================================
    // HOURLY RATE LIMITING (with sliding window if available)
    // =========================================================================
    
    let originsQuery, ipsQuery;
    
    // Performance safeguard: limit results to prevent memory issues with large tables
    // 10000 should be more than enough for legitimate origins/IPs
    const QUERY_LIMIT = 10000;
    
    if (hasSlidingWindow) {
      // Sliding window: effective_count = current_hour + (previous_hour × weight)
      // Query ALL origins/IPs with any hourly activity, determine blocking in code
      
      originsQuery = `
        WITH current_hour AS (
          SELECT 
            origin_key as origin,
            SUM((origin_value)::bigint) as current_requests
          FROM ip_table, 
               jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb)) AS x(origin_key, origin_value)
          GROUP BY origin_key
        ),
        previous_hour AS (
          SELECT 
            origin_key as origin,
            SUM((origin_value)::bigint) as previous_requests
          FROM ip_table, 
               jsonb_each_text(COALESCE(origins_previous_hour, '{}'::jsonb)) AS x(origin_key, origin_value)
          GROUP BY origin_key
        )
        SELECT 
          COALESCE(c.origin, p.origin) as origin,
          COALESCE(c.current_requests, 0) as current_requests,
          COALESCE(p.previous_requests, 0) as previous_requests,
          COALESCE(c.current_requests, 0) + (COALESCE(p.previous_requests, 0) * $1::numeric) as effective_requests
        FROM current_hour c
        FULL OUTER JOIN previous_hour p ON c.origin = p.origin
        ORDER BY effective_requests DESC
        LIMIT ${QUERY_LIMIT}
      `;
      
      ipsQuery = `
        SELECT 
          ip,
          requests_last_hour as current_requests,
          requests_previous_hour as previous_requests,
          requests_last_hour + (requests_previous_hour * $1::numeric) as effective_requests,
          COALESCE(
            (SELECT SUM((value)::bigint) FROM jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb))),
            0
          ) as origin_requests_current,
          COALESCE(
            (SELECT SUM((value)::bigint) FROM jsonb_each_text(COALESCE(origins_previous_hour, '{}'::jsonb))),
            0
          ) as origin_requests_previous
        FROM ip_table
        WHERE requests_last_hour > 0 OR requests_previous_hour > 0
        ORDER BY effective_requests DESC
        LIMIT ${QUERY_LIMIT}
      `;
    } else {
      // Fixed window (legacy behavior) - query ALL with any activity
      originsQuery = `
        SELECT 
          origin_key as origin,
          SUM((origin_value)::bigint) as current_requests,
          0 as previous_requests,
          SUM((origin_value)::bigint) as effective_requests
        FROM ip_table, 
             jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb)) AS x(origin_key, origin_value)
        GROUP BY origin_key
        ORDER BY effective_requests DESC
        LIMIT ${QUERY_LIMIT}
      `;
      
      ipsQuery = `
        SELECT 
          ip,
          requests_last_hour as current_requests,
          0 as previous_requests,
          requests_last_hour as effective_requests,
          COALESCE(
            (SELECT SUM((value)::bigint) FROM jsonb_each_text(COALESCE(${originColumn}, '{}'::jsonb))),
            0
          ) as origin_requests_current,
          0 as origin_requests_previous
        FROM ip_table
        WHERE requests_last_hour > 0
        ORDER BY effective_requests DESC
        LIMIT ${QUERY_LIMIT}
      `;
    }
    
    // Note: queries now only take the weight parameter, not the limit
    const originsResult = await pool.query(originsQuery, [previousHourWeight]);
    const ipsResult = await pool.query(ipsQuery, [previousHourWeight]);

    // Process ALL origins - store counts for all, block only if over limit
    const newBlockedOrigins = new Set();
    const newOriginCurrentHour = new Map();
    const newOriginPreviousHour = new Map();
    const newOriginEffective = new Map();
    
    for (const row of originsResult.rows) {
      const cleanOrigin = stripProtocol(row.origin);
      if (cleanOrigin && !isLocalOrigin(cleanOrigin)) {
        const currentHour = parseInt(row.current_requests) || 0;
        const previousHour = parseInt(row.previous_requests) || 0;
        const effective = Math.round(parseFloat(row.effective_requests));
        
        // Store counts for ALL origins
        newOriginCurrentHour.set(cleanOrigin, currentHour);
        newOriginPreviousHour.set(cleanOrigin, previousHour);
        newOriginEffective.set(cleanOrigin, effective);
        
        // Only block if over limit
        if (effective > originRateLimitPerHour) {
          newBlockedOrigins.add(cleanOrigin);
        }
      }
    }

    // Process ALL IPs - store counts for all, block only if over limit
    const newBlockedIPs = new Set();
    const newIpCurrentHour = new Map();
    const newIpPreviousHour = new Map();
    const newIpEffective = new Map();
    
    for (const row of ipsResult.rows) {
      const effectiveTotal = parseFloat(row.effective_requests);
      const currentTotal = parseInt(row.current_requests) || 0;
      const previousTotal = parseInt(row.previous_requests) || 0;
      const originCurrent = parseInt(row.origin_requests_current) || 0;
      const originPrevious = parseInt(row.origin_requests_previous) || 0;
      const effectiveOrigin = originCurrent + (originPrevious * previousHourWeight);
      const effectiveNoOrigin = effectiveTotal - effectiveOrigin;
      
      // Calculate no-origin counts for current and previous hour
      const noOriginCurrent = currentTotal - originCurrent;
      const noOriginPrevious = previousTotal - originPrevious;
      
      // Store counts for ALL IPs (if they have any no-origin requests)
      if (noOriginCurrent > 0 || noOriginPrevious > 0 || effectiveNoOrigin > 0) {
        newIpCurrentHour.set(row.ip, noOriginCurrent);
        newIpPreviousHour.set(row.ip, noOriginPrevious);
        newIpEffective.set(row.ip, Math.round(effectiveNoOrigin));
      }
      
      // Only block if over limit
      if (effectiveNoOrigin > ipRateLimitPerHour) {
        newBlockedIPs.add(row.ip);
      }
    }

    // =========================================================================
    // DAILY RATE LIMITING (if columns exist)
    // =========================================================================
    
    const newDailyBlockedOrigins = new Set();
    const newDailyBlockedIPs = new Set();
    const newOriginDailyCounts = new Map();
    const newIpDailyCounts = new Map();
    
    if (hasDailyLimit) {
      // Query ALL daily origin counts (not just over-limit)
      // We need all counts for status display, then determine blocking separately
      const dailyOriginsQuery = `
        SELECT 
          origin_key as origin,
          SUM((origin_value)::bigint) as total_requests
        FROM ip_table, 
             jsonb_each_text(COALESCE(origins_today, '{}'::jsonb)) AS x(origin_key, origin_value)
        GROUP BY origin_key
        ORDER BY total_requests DESC
        LIMIT ${QUERY_LIMIT}
      `;
      
      const dailyOriginsResult = await pool.query(dailyOriginsQuery);
      
      for (const row of dailyOriginsResult.rows) {
        const cleanOrigin = stripProtocol(row.origin);
        if (cleanOrigin && !isLocalOrigin(cleanOrigin)) {
          const dailyCount = parseInt(row.total_requests);
          newOriginDailyCounts.set(cleanOrigin, dailyCount);
          
          // Block if over daily limit
          if (dailyCount > originRateLimitPerDay) {
            newDailyBlockedOrigins.add(cleanOrigin);
          }
        }
      }
      
      // Query ALL daily IP counts (not just over-limit)
      const dailyIpsQuery = `
        SELECT 
          ip,
          requests_today,
          COALESCE(
            (SELECT SUM((value)::bigint) FROM jsonb_each_text(COALESCE(origins_today, '{}'::jsonb))),
            0
          ) as origin_requests
        FROM ip_table
        WHERE requests_today > 0
        ORDER BY requests_today DESC
        LIMIT ${QUERY_LIMIT}
      `;
      
      const dailyIpsResult = await pool.query(dailyIpsQuery);
      
      for (const row of dailyIpsResult.rows) {
        const totalRequests = parseInt(row.requests_today);
        const originRequests = parseInt(row.origin_requests);
        const noOriginRequests = totalRequests - originRequests;
        
        // Store the daily count
        if (noOriginRequests > 0) {
          newIpDailyCounts.set(row.ip, noOriginRequests);
        }
        
        // Block if over daily limit
        if (noOriginRequests > ipRateLimitPerDay) {
          newDailyBlockedIPs.add(row.ip);
        }
      }
    }

    // Atomic update of state
    state.blockedOrigins = newBlockedOrigins;
    state.blockedIPs = newBlockedIPs;
    state.originCurrentHour = newOriginCurrentHour;
    state.originPreviousHour = newOriginPreviousHour;
    state.originEffective = newOriginEffective;
    state.ipCurrentHour = newIpCurrentHour;
    state.ipPreviousHour = newIpPreviousHour;
    state.ipEffective = newIpEffective;
    state.dailyBlockedOrigins = newDailyBlockedOrigins;
    state.dailyBlockedIPs = newDailyBlockedIPs;
    state.originDailyCounts = newOriginDailyCounts;
    state.ipDailyCounts = newIpDailyCounts;
    state.lastPollTime = new Date();
    state.pollErrors = 0;

    // Log if anything is blocked
    const hourlyBlocked = newBlockedOrigins.size + newBlockedIPs.size;
    const dailyBlocked = newDailyBlockedOrigins.size + newDailyBlockedIPs.size;
    
    if (hourlyBlocked > 0 || dailyBlocked > 0) {
      console.log(`🚦 Rate limit update: ${newBlockedOrigins.size} origins (hourly), ${newBlockedIPs.size} IPs (hourly), ${newDailyBlockedOrigins.size} origins (daily), ${newDailyBlockedIPs.size} IPs (daily)`);
      if (newBlockedOrigins.size > 0) {
        console.log(`   Hourly blocked origins: ${[...newBlockedOrigins].join(', ')}`);
      }
      if (newBlockedIPs.size > 0) {
        console.log(`   Hourly blocked IPs: ${[...newBlockedIPs].join(', ')}`);
      }
      if (newDailyBlockedOrigins.size > 0) {
        console.log(`   Daily blocked origins: ${[...newDailyBlockedOrigins].join(', ')}`);
      }
      if (newDailyBlockedIPs.size > 0) {
        console.log(`   Daily blocked IPs: ${[...newDailyBlockedIPs].join(', ')}`);
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
 * Checks both hourly (sliding window) and daily limits
 * 
 * CRITICAL: This function is called on every request and MUST:
 * - Be fast (no I/O, just in-memory lookups)
 * - Never throw errors (wrapped in try-catch)
 * - Default to ALLOWING requests if anything goes wrong (fail open for availability)
 * 
 * @param {string} ip - The client IP address
 * @param {string} origin - The request origin (may be null/undefined)
 * @returns {object} { limited: boolean, reason: string|null, retryAfter: number|null }
 */
function checkRateLimit(ip, origin) {
  try {
    const cleanOrigin = stripProtocol(origin);
    const hasRealOrigin = cleanOrigin && !isLocalOrigin(cleanOrigin);

    if (hasRealOrigin) {
      // This is a deployed app - check origin-based limits
      
      // Check DAILY limit first (longer block)
      if (state.dailyBlockedOrigins.has(cleanOrigin)) {
        const count = state.originDailyCounts.get(cleanOrigin) || 0;
        console.log(`🚦 Rate limited: Origin ${cleanOrigin} exceeded daily limit (${count}/${originRateLimitPerDay})`);
        return {
          limited: true,
          reason: `Origin ${cleanOrigin} has exceeded daily rate limit (${count}/${originRateLimitPerDay} requests/day)`,
          retryAfter: getSecondsUntilMidnightUTC()
        };
      }
      
      // Check HOURLY limit (sliding window)
      if (state.blockedOrigins.has(cleanOrigin)) {
        const count = state.originEffective.get(cleanOrigin) || 0;
        console.log(`🚦 Rate limited: Origin ${cleanOrigin} exceeded hourly limit (~${count}/${originRateLimitPerHour})`);
        return {
          limited: true,
          reason: `Origin ${cleanOrigin} has exceeded hourly rate limit (~${count}/${originRateLimitPerHour} requests/hour)`,
          retryAfter: getSecondsUntilNextHour()
        };
      }
    } else {
      // This is local testing - check IP-based limits
      
      // Check DAILY limit first (longer block)
      if (state.dailyBlockedIPs.has(ip)) {
        const count = state.ipDailyCounts.get(ip) || 0;
        console.log(`🚦 Rate limited: IP ${ip} exceeded daily limit (${count}/${ipRateLimitPerDay})`);
        return {
          limited: true,
          reason: `IP ${ip} has exceeded daily rate limit for non-origin requests (${count}/${ipRateLimitPerDay} requests/day)`,
          retryAfter: getSecondsUntilMidnightUTC()
        };
      }
      
      // Check HOURLY limit (sliding window)
      if (state.blockedIPs.has(ip)) {
        const count = state.ipEffective.get(ip) || 0;
        console.log(`🚦 Rate limited: IP ${ip} exceeded hourly limit (~${count}/${ipRateLimitPerHour})`);
        return {
          limited: true,
          reason: `IP ${ip} has exceeded hourly rate limit for non-origin requests (~${count}/${ipRateLimitPerHour} requests/hour)`,
          retryAfter: getSecondsUntilNextHour()
        };
      }
    }

    // Not rate limited
    return { limited: false, reason: null, retryAfter: null };
    
  } catch (error) {
    // CRITICAL: Never let rate limiting errors block legitimate traffic
    // If something goes wrong, fail open (allow the request)
    console.error('⚠️  Rate limit check error (allowing request):', error.message);
    return { limited: false, reason: null, retryAfter: null };
  }
}

/**
 * Calculate seconds until the next hour boundary (when hourly limits shift)
 * Note: With sliding window, limits don't fully "reset" but shift smoothly
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
 * Calculate seconds until midnight UTC (when daily limits reset)
 */
function getSecondsUntilMidnightUTC() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return Math.ceil((tomorrow - now) / 1000);
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
      message: "Rate limit exceeded."
    }
  };
}

/**
 * Get current rate limiter status (for monitoring endpoints)
 */
function getRateLimitStatus() {
  const now = new Date();
  const minutesIntoHour = now.getMinutes() + (now.getSeconds() / 60);
  const previousHourWeight = 1 - (minutesIntoHour / 60);
  const secondsUntilNextHour = getSecondsUntilNextHour();
  const secondsUntilMidnight = getSecondsUntilMidnightUTC();
  
  // Build detailed origin status with current/previous/effective counts
  const originStatus = {};
  for (const [origin, effectiveCount] of state.originEffective) {
    const currentHour = state.originCurrentHour.get(origin) || 0;
    const previousHour = state.originPreviousHour.get(origin) || 0;
    const dailyCount = state.originDailyCounts.get(origin) || 0;
    originStatus[origin] = {
      currentHour,
      previousHour,
      effectiveHourly: effectiveCount,
      hourlyBlocked: state.blockedOrigins.has(origin),
      daily: dailyCount,
      dailyBlocked: state.dailyBlockedOrigins.has(origin)
    };
  }
  // Add any origins only in daily counts
  for (const [origin, dailyCount] of state.originDailyCounts) {
    if (!originStatus[origin]) {
      originStatus[origin] = {
        currentHour: 0,
        previousHour: 0,
        effectiveHourly: 0,
        hourlyBlocked: false,
        daily: dailyCount,
        dailyBlocked: state.dailyBlockedOrigins.has(origin)
      };
    }
  }
  
  // Build detailed IP status with current/previous/effective counts
  const ipStatus = {};
  for (const [ip, effectiveCount] of state.ipEffective) {
    const currentHour = state.ipCurrentHour.get(ip) || 0;
    const previousHour = state.ipPreviousHour.get(ip) || 0;
    const dailyCount = state.ipDailyCounts.get(ip) || 0;
    ipStatus[ip] = {
      currentHour,
      previousHour,
      effectiveHourly: effectiveCount,
      hourlyBlocked: state.blockedIPs.has(ip),
      daily: dailyCount,
      dailyBlocked: state.dailyBlockedIPs.has(ip)
    };
  }
  // Add any IPs only in daily counts
  for (const [ip, dailyCount] of state.ipDailyCounts) {
    if (!ipStatus[ip]) {
      ipStatus[ip] = {
        currentHour: 0,
        previousHour: 0,
        effectiveHourly: 0,
        hourlyBlocked: false,
        daily: dailyCount,
        dailyBlocked: state.dailyBlockedIPs.has(ip)
      };
    }
  }
  
  return {
    // Sliding window info
    slidingWindow: {
      minutesIntoHour: Math.round(minutesIntoHour * 10) / 10,
      previousHourWeight: Math.round(previousHourWeight * 1000) / 1000,
      explanation: `effectiveCount = currentHour + (previousHour × ${(previousHourWeight * 100).toFixed(1)}%)`
    },
    // Time until resets
    timeUntilReset: {
      hourlySeconds: secondsUntilNextHour,
      hourlyMinutes: Math.round(secondsUntilNextHour / 60),
      dailySeconds: secondsUntilMidnight,
      dailyHours: Math.round(secondsUntilMidnight / 3600 * 10) / 10
    },
    // Detailed origin status
    origins: originStatus,
    // Detailed IP status (no-origin requests)
    ips: ipStatus,
    // Summary counts
    summary: {
      hourlyBlockedOrigins: state.blockedOrigins.size,
      hourlyBlockedIPs: state.blockedIPs.size,
      dailyBlockedOrigins: state.dailyBlockedOrigins.size,
      dailyBlockedIPs: state.dailyBlockedIPs.size,
      totalTrackedOrigins: Object.keys(originStatus).length,
      totalTrackedIPs: Object.keys(ipStatus).length
    },
    // Status
    lastPollTime: state.lastPollTime?.toISOString() || null,
    pollErrors: state.pollErrors,
    // Feature detection
    features: {
      originsLastHourColumn: state.originsLastHourExists,
      slidingWindowColumns: state.slidingWindowExists,
      dailyLimitColumns: state.dailyLimitExists,
    },
    // Configuration
    config: {
      originRateLimitPerHour,
      ipRateLimitPerHour,
      originRateLimitPerDay,
      ipRateLimitPerDay,
      rateLimitPollInterval
    }
  };
}

/**
 * Start the rate limit polling loop
 */
function startRateLimitPolling() {
  console.log(`🚦 Starting rate limit polling (every ${rateLimitPollInterval}s)`);
  console.log(`   Hourly limits (sliding window):`);
  console.log(`     - Origin: ${originRateLimitPerHour} req/hour`);
  console.log(`     - IP (no-origin): ${ipRateLimitPerHour} req/hour`);
  console.log(`   Daily limits:`);
  console.log(`     - Origin: ${originRateLimitPerDay} req/day`);
  console.log(`     - IP (no-origin): ${ipRateLimitPerDay} req/day`);

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
