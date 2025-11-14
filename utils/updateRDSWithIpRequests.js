import { getPool } from './postgresClient.js';

// Helper function to get current UTC timestamp in seconds
function getCurrentUTCTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// Store the last reset time in memory (will be synced from DB)
let lastGlobalReset = null;

// Reset all IPs' hourly counters every hour
async function resetHourlyCounters() {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    const pool = await getPool();
    
    // If we don't know the last reset time, get it from the database
    if (lastGlobalReset === null) {
      // Use MIN to get the oldest reset time (the actual global reset)
      // After a global reset, all IPs have the same timestamp
      // New IPs added later would have newer timestamps, so MAX would be wrong
      const result = await pool.query(
        'SELECT MIN(last_reset_timestamp) as last_reset FROM ip_table'
      );
      
      if (result.rows.length > 0 && result.rows[0].last_reset) {
        lastGlobalReset = parseInt(result.rows[0].last_reset);
        console.log(`📅 Synced last reset time from database: ${new Date(lastGlobalReset * 1000).toISOString()}`);
      } else {
        // No IPs in database yet, initialize to now
        lastGlobalReset = currentTimestamp;
        console.log(`📅 No previous reset found, initializing to current time`);
      }
    }
    
    const hoursSinceReset = (currentTimestamp - lastGlobalReset) / 3600;

    // Only reset if at least 1 hour has passed
    if (hoursSinceReset >= 1) {
      const result = await pool.query(
        'UPDATE ip_table SET requests_last_hour = 0, last_reset_timestamp = $1',
        [currentTimestamp]
      );
      
      lastGlobalReset = currentTimestamp;
      console.log(`⏰ Global hourly reset completed - Reset ${result.rowCount} IPs at ${new Date(currentTimestamp * 1000).toISOString()} (${hoursSinceReset.toFixed(2)} hours since last reset)`);
    }
  } catch (error) {
    console.error('❌ Error during global hourly reset:', error);
    // Reset lastGlobalReset so we retry fetching from DB next time
    lastGlobalReset = null;
  }
}

async function updateRDSWithIpRequests(ipCountMap) {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    
    // Always check if we need to do a global hourly reset, even if no new requests
    // This ensures hourly resets happen on schedule regardless of traffic
    await resetHourlyCounters();
    
    const hasNewRequests = Object.keys(ipCountMap).length > 0;

    if (!hasNewRequests) {
      console.log("ipCountMap is empty - no updates needed");
      return;
    }

    console.log(`Updating IP requests in RDS at UTC timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);

    const pool = await getPool();
    const client = await pool.connect();

    try {
      // Process each IP with atomic upsert
      let updateCount = 0;

      for (const ip in ipCountMap) {
        const ipData = ipCountMap[ip];
        const requestCount = ipData.count || 0;
        const origins = ipData.origins || {};

        // Atomic upsert with JSONB merge - much simpler now with global resets!
        // This query does everything atomically without a read-before-write:
        // 1. Inserts new IP if it doesn't exist (with lastGlobalReset timestamp)
        // 2. Updates existing IP by adding to counters
        // 3. Merges origins JSONB
        // Note: last_reset_timestamp is only updated during global reset, not here
        const query = `
          INSERT INTO ip_table (
            ip, 
            requests_total, 
            requests_last_hour, 
            last_reset_timestamp, 
            origins
          ) VALUES ($1, $2::bigint, $2::integer, $3, $4::jsonb)
          ON CONFLICT (ip) DO UPDATE SET
            requests_total = ip_table.requests_total + EXCLUDED.requests_total,
            requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
            origins = COALESCE(ip_table.origins, '{}'::jsonb) || EXCLUDED.origins,
            updated_at = NOW()
          RETURNING requests_total, requests_last_hour;
        `;

        // Use lastGlobalReset for new IPs so they align with the global reset time
        // This prevents new IPs from pushing the MIN(last_reset_timestamp) forward
        const values = [
          ip,
          requestCount,
          lastGlobalReset || currentTimestamp, // Use global reset time if known
          JSON.stringify(origins)
        ];

        const result = await client.query(query, values);
        const row = result.rows[0];

        console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | Origins: ${JSON.stringify(origins)}`);
        updateCount++;
      }

      console.log(`✅ Successfully updated ${updateCount} IPs in RDS PostgreSQL`);

    } finally {
      client.release();
    }

  } catch (error) {
    console.error("❌ Error updating RDS with IP requests:", error);
    console.error("Error details:", {
      message: error.message,
      code: error.code,
      type: error.constructor.name
    });
    
    // Throw the error so backgroundTasks can restore the data
    throw error;
  }
}

export { updateRDSWithIpRequests };

