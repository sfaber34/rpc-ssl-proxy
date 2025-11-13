import { db } from './firebaseClient.js';

const ipsCollectionName = process.env.FIREBASE_COLLECTION_IPS || 'ips';

// In-memory cache of IP request counts
// Structure: { ip: { requestsLastHour: number, lastSynced: timestamp } }
const ipRequestCache = {};

// Configuration
const maxHourlyRequests = parseInt(process.env.MAX_HOURLY_REQUESTS) || 0;
const syncInterval = parseInt(process.env.RATE_LIMIT_SYNC_INTERVAL) || 60000; // Default: 60 seconds
const cacheExpiry = parseInt(process.env.RATE_LIMIT_CACHE_EXPIRY) || 3600000; // Default: 1 hour

/**
 * Check if an IP has exceeded the hourly rate limit
 * @param {string} ip - The IP address to check
 * @returns {Object} - { allowed: boolean, currentCount: number, limit: number }
 */
function checkRateLimit(ip) {
  // If MAX_HOURLY_REQUESTS is not set or is 0, don't enforce rate limiting
  if (!maxHourlyRequests || maxHourlyRequests <= 0) {
    return { allowed: true, currentCount: 0, limit: 0 };
  }

  // Skip unknown IPs
  if (!ip || ip === 'unknown') {
    return { allowed: true, currentCount: 0, limit: maxHourlyRequests };
  }

  // Get cached count for this IP (default to 0 if not in cache)
  const cachedData = ipRequestCache[ip] || { requestsLastHour: 0, lastSynced: 0 };
  const currentCount = cachedData.requestsLastHour || 0;

  // Check if over limit
  const allowed = currentCount < maxHourlyRequests;

  return {
    allowed,
    currentCount,
    limit: maxHourlyRequests
  };
}

/**
 * Increment the request count for an IP in the cache
 * @param {string} ip - The IP address
 * @param {number} count - Number of requests to add (default 1)
 */
function incrementRequestCount(ip, count = 1) {
  if (!ip || ip === 'unknown') return;

  if (!ipRequestCache[ip]) {
    ipRequestCache[ip] = {
      requestsLastHour: 0,
      lastSynced: Date.now()
    };
  }

  ipRequestCache[ip].requestsLastHour += count;
}

/**
 * Sync the in-memory cache with Firestore's requestsLastHour data
 * This runs periodically in the background
 */
async function syncCacheWithFirestore() {
  try {
    console.log('🔄 Syncing rate limit cache with Firestore...');
    
    // Get all IPs with data from Firestore
    const ipsSnapshot = await db.collection(ipsCollectionName).get();
    
    const now = Date.now();
    let syncedCount = 0;

    ipsSnapshot.forEach(doc => {
      const ip = doc.id;
      const data = doc.data();
      
      if (data && typeof data.requestsLastHour === 'number') {
        // Only update if we don't have fresher data
        // If the IP exists in cache and was recently updated locally, add to Firestore value
        // Otherwise, use Firestore as source of truth
        if (ipRequestCache[ip] && (now - ipRequestCache[ip].lastSynced) < 30000) {
          // Recently updated locally - keep local increment on top of Firestore value
          const localIncrement = ipRequestCache[ip].requestsLastHour - (ipRequestCache[ip].firestoreBase || 0);
          ipRequestCache[ip] = {
            requestsLastHour: data.requestsLastHour + localIncrement,
            lastSynced: now,
            firestoreBase: data.requestsLastHour
          };
        } else {
          // Use Firestore as source of truth
          ipRequestCache[ip] = {
            requestsLastHour: data.requestsLastHour,
            lastSynced: now,
            firestoreBase: data.requestsLastHour
          };
        }
        syncedCount++;
      }
    });

    // Clean up stale cache entries (IPs not seen in over an hour)
    const ipsToClean = [];
    for (const [ip, data] of Object.entries(ipRequestCache)) {
      if (now - data.lastSynced > cacheExpiry) {
        ipsToClean.push(ip);
      }
    }
    
    ipsToClean.forEach(ip => delete ipRequestCache[ip]);
    
    console.log(`✅ Rate limit cache synced: ${syncedCount} IPs updated, ${ipsToClean.length} stale entries cleaned`);
  } catch (error) {
    console.error('❌ Error syncing rate limit cache with Firestore:', error);
  }
}

/**
 * Start the background sync process
 */
function startRateLimitSync() {
  if (!maxHourlyRequests || maxHourlyRequests <= 0) {
    console.log('⚠️  MAX_HOURLY_REQUESTS not set or is 0 - rate limiting disabled');
    return;
  }

  console.log(`🚦 Rate limiting enabled: ${maxHourlyRequests} requests per hour per IP`);
  
  // Initial sync
  syncCacheWithFirestore();
  
  // Periodic sync
  setInterval(() => {
    try {
      syncCacheWithFirestore();
    } catch (error) {
      console.error('Critical error in rate limit sync interval:', error);
    }
  }, syncInterval);
}

/**
 * Generate a JSON-RPC error response for rate limiting
 * @param {number} limit - The rate limit value
 * @returns {Object} - JSON-RPC error object
 */
function generateRateLimitError(limit) {
  return {
    jsonrpc: "2.0",
    error: {
      code: 429,
      message: `This IP has exceeded the hourly request limit of ${limit}.`
    }
  };
}

export {
  checkRateLimit,
  incrementRequestCount,
  startRateLimitSync,
  generateRateLimitError,
  ipRequestCache // Export for testing/debugging
};

