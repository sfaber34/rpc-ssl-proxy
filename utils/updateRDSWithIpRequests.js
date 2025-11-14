import { getPool } from './postgresClient.js';

// Helper function to get current UTC timestamp in seconds
function getCurrentUTCTimestamp() {
  return Math.floor(Date.now() / 1000);
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

    const pool = await getPool();
    const client = await pool.connect();

    try {
      // Process each IP with atomic upsert
      let updateCount = 0;

      for (const ip in ipCountMap) {
        const ipData = ipCountMap[ip];
        const requestCount = ipData.count || 0;
        const origins = ipData.origins || {};

        // Merge existing origins with new ones using PostgreSQL's JSONB operators
        // This query does everything atomically without a read-before-write:
        // 1. Inserts new IP if it doesn't exist
        // 2. Updates existing IP
        // 3. Handles hourly reset if needed
        // 4. Merges origins JSONB
        const query = `
          INSERT INTO ip_table (
            ip, 
            requests_total, 
            requests_last_hour, 
            last_reset_timestamp, 
            origins
          ) VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (ip) DO UPDATE SET
            requests_total = ip_table.requests_total + EXCLUDED.requests_total,
            requests_last_hour = CASE 
              WHEN ($4 - ip_table.last_reset_timestamp) >= 3600 
              THEN EXCLUDED.requests_last_hour
              ELSE ip_table.requests_last_hour + EXCLUDED.requests_last_hour
            END,
            last_reset_timestamp = CASE
              WHEN ($4 - ip_table.last_reset_timestamp) >= 3600
              THEN EXCLUDED.last_reset_timestamp
              ELSE ip_table.last_reset_timestamp
            END,
            origins = COALESCE(ip_table.origins, '{}'::jsonb) || EXCLUDED.origins,
            updated_at = NOW()
          RETURNING requests_total, requests_last_hour, 
                    ($4 - last_reset_timestamp) >= 3600 as was_reset;
        `;

        const values = [
          ip,
          requestCount,
          requestCount,
          currentTimestamp,
          JSON.stringify(origins)
        ];

        const result = await client.query(query, values);
        const row = result.rows[0];

        if (row.was_reset) {
          console.log(`⏰ Reset requestsLastHour for IP ${ip}`);
        }

        console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | Origins: ${JSON.stringify(origins)}`);
        updateCount++;
      }

      console.log(`✅ Successfully updated ${updateCount} IPs in RDS PostgreSQL`);

    } finally {
      client.release();
    }

  } catch (error) {
    console.error("❌ Error updating RDS with IP requests:", error);
    throw error;
  }
}

export { updateRDSWithIpRequests };

