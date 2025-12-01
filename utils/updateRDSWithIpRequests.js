import { getPool } from './postgresClient.js';

// Helper function to get current UTC timestamp in seconds
function getCurrentUTCTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// Helper function to get the start of the current hour (rounded down to :00:00)
function getStartOfCurrentHour(timestamp) {
  return Math.floor(timestamp / 3600) * 3600;
}

// Helper function to get the start of the previous hour
function getStartOfPreviousHour(timestamp) {
  return getStartOfCurrentHour(timestamp) - 3600;
}

// Store the last reset time in memory (will be synced from DB)
let lastGlobalReset = null;

// Store the last cleanup time to run cleanup once per day
let lastCleanupTimestamp = null;

// Capture hourly snapshot to ip_history_table before resetting counters
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function captureHourlySnapshot(hourTimestamp) {
  try {
    const pool = await getPool();
    
    // Query all IPs with activity in the last hour
    const snapshotQuery = `
      SELECT ip, requests_last_hour, origins
      FROM ip_table
      WHERE requests_last_hour > 0
    `;
    
    const result = await pool.query(snapshotQuery);
    
    if (result.rows.length === 0) {
      console.log('📸 No active IPs in last hour - skipping history snapshot');
      return;
    }
    
    console.log(`📸 Capturing hourly snapshot: ${result.rows.length} active IPs for hour ${new Date(hourTimestamp * 1000).toISOString()}`);
    
    // Batch insert all records into ip_history_table
    // Using INSERT ... ON CONFLICT DO NOTHING to handle any potential duplicates gracefully
    let insertedCount = 0;
    
    for (const row of result.rows) {
      try {
        const insertQuery = `
          INSERT INTO ip_history_table (hour_timestamp, ip, request_count, origins)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (hour_timestamp, ip) DO NOTHING
        `;
        
        await pool.query(insertQuery, [
          hourTimestamp,
          row.ip,
          row.requests_last_hour,
          row.origins
        ]);
        
        insertedCount++;
      } catch (insertError) {
        // Log individual insert errors but continue with other IPs
        console.error(`⚠️  Failed to insert history for IP ${row.ip}:`, insertError.message);
      }
    }
    
    console.log(`✅ Snapshot captured: ${insertedCount}/${result.rows.length} IPs saved to history`);
    
  } catch (error) {
    // CRITICAL: Catch all errors to prevent crashing the main proxy
    console.error('⚠️  Error capturing hourly snapshot (non-fatal, continuing):', error.message);
    // Do NOT throw - we want the main proxy to continue running
  }
}

// Clean up old history records (older than 30 days)
// Runs once per day to keep database size manageable
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function cleanupOldHistory() {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    
    // Check if we've done cleanup in the last 24 hours
    if (lastCleanupTimestamp !== null) {
      const hoursSinceCleanup = (currentTimestamp - lastCleanupTimestamp) / 3600;
      if (hoursSinceCleanup < 24) {
        // Too soon, skip cleanup
        return;
      }
    }
    
    console.log('🧹 Running daily cleanup of old IP history records...');
    
    const pool = await getPool();
    
    // Calculate cutoff timestamp (30 days ago)
    const cutoffQuery = `SELECT EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days') as cutoff`;
    const cutoffResult = await pool.query(cutoffQuery);
    const cutoffTimestamp = parseInt(cutoffResult.rows[0].cutoff);
    
    // Check if there are old records to delete
    const countResult = await pool.query(
      'SELECT COUNT(*) as old_count FROM ip_history_table WHERE hour_timestamp < $1',
      [cutoffTimestamp]
    );
    
    const oldCount = parseInt(countResult.rows[0].old_count);
    
    if (oldCount === 0) {
      console.log('✅ No old history records to clean up');
      lastCleanupTimestamp = currentTimestamp;
      return;
    }
    
    // Delete old records
    const deleteResult = await pool.query(
      'DELETE FROM ip_history_table WHERE hour_timestamp < $1',
      [cutoffTimestamp]
    );
    
    console.log(`✅ Cleanup complete: Deleted ${deleteResult.rowCount} records older than 30 days`);
    lastCleanupTimestamp = currentTimestamp;
    
  } catch (error) {
    // CRITICAL: Catch all errors to prevent crashing the main proxy
    console.error('⚠️  Error during history cleanup (non-fatal, continuing):', error.message);
    // Do NOT throw - we want the main proxy to continue running
  }
}

// Reset all IPs' hourly counters every hour (aligned to clock hour boundaries)
async function resetHourlyCounters() {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    const currentHourStart = getStartOfCurrentHour(currentTimestamp);
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
        // No IPs in database yet, initialize to start of current hour
        lastGlobalReset = currentHourStart;
        console.log(`📅 No previous reset found, initializing to start of current hour: ${new Date(lastGlobalReset * 1000).toISOString()}`);
      }
    }
    
    // Check if we've crossed into a new hour boundary
    // lastGlobalReset should be start of a previous hour, currentHourStart is start of current hour
    if (currentHourStart > lastGlobalReset) {
      // We've crossed into a new hour (or multiple hours if system was down)
      const hoursPassed = (currentHourStart - lastGlobalReset) / 3600;
      
      console.log(`⏰ Hour boundary crossed - ${hoursPassed.toFixed(0)} hour(s) passed since ${new Date(lastGlobalReset * 1000).toISOString()}`);
      
      // STEP 1: Capture snapshot to history BEFORE resetting
      // Use lastGlobalReset as the hour_timestamp (the hour that just completed)
      await captureHourlySnapshot(lastGlobalReset);
      
      // STEP 2: Reset the hourly counters
      // Set last_reset_timestamp to the start of the current hour
      const result = await pool.query(
        'UPDATE ip_table SET requests_last_hour = 0, last_reset_timestamp = $1',
        [currentHourStart]
      );
      
      lastGlobalReset = currentHourStart;
      console.log(`✅ Global hourly reset completed - Reset ${result.rowCount} IPs to hour starting at ${new Date(currentHourStart * 1000).toISOString()}`);
      
      // STEP 3: Run daily cleanup if needed
      await cleanupOldHistory();
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
        // If lastGlobalReset is not set, use start of current hour
        const resetTimestamp = lastGlobalReset || getStartOfCurrentHour(currentTimestamp);
        const values = [
          ip,
          requestCount,
          resetTimestamp,
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

