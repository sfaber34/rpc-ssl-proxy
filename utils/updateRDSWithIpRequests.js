import { getPool } from './postgresClient.js';

// Helper function to get current UTC timestamp in seconds
function getCurrentUTCTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// Store the last reset time in memory
let lastGlobalReset = Math.floor(Date.now() / 1000);

// Reset all IPs' hourly counters every hour
async function resetHourlyCounters() {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    const hoursSinceReset = (currentTimestamp - lastGlobalReset) / 3600;

    // Only reset if at least 1 hour has passed
    if (hoursSinceReset >= 1) {
      const pool = await getPool();
      const result = await pool.query(
        'UPDATE ip_table SET requests_last_hour = 0, last_reset_timestamp = $1',
        [currentTimestamp]
      );
      
      lastGlobalReset = currentTimestamp;
      console.log(`⏰ Global hourly reset completed - Reset ${result.rowCount} IPs at ${new Date(currentTimestamp * 1000).toISOString()}`);
    }
  } catch (error) {
    console.error('❌ Error during global hourly reset:', error);
  }
}

async function updateRDSWithIpRequests(ipCountMap) {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    const hasNewRequests = Object.keys(ipCountMap).length > 0;

    if (!hasNewRequests) {
      console.log("ipCountMap is empty - no updates needed");
      return;
    }

    console.log(`Updating IP requests in RDS at UTC timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);

    // Check if we need to do a global hourly reset
    await resetHourlyCounters();

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
        // 1. Inserts new IP if it doesn't exist
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

        const values = [
          ip,
          requestCount,
          currentTimestamp, // Only used for initial INSERT
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

