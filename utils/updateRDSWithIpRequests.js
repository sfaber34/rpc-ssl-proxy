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

// Helper function to get the start of the current month in UTC (e.g., 2025-12-01 00:00:00 UTC)
// Returns Unix timestamp in seconds
function getStartOfCurrentMonth(timestamp) {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-11
  return Math.floor(new Date(Date.UTC(year, month, 1, 0, 0, 0)) / 1000);
}

// Helper function to check if we're in a different month than the reset timestamp
// Handles variable month lengths automatically (28/29/30/31 days)
function isNewMonth(currentTimestamp, lastResetTimestamp) {
  const currentMonth = getStartOfCurrentMonth(currentTimestamp);
  const resetMonth = getStartOfCurrentMonth(lastResetTimestamp);
  return currentMonth > resetMonth;
}

// Store the last reset time in memory (will be synced from DB)
let lastGlobalReset = null;

// Store the last monthly reset time in memory (will be synced from DB)
let lastMonthlyReset = null;

// Flag to track if monthly columns exist in the database
// This prevents errors if the migration hasn't been run yet
let monthlyTrackingEnabled = null;

// Store the last cleanup time to run cleanup once per day
let lastCleanupTimestamp = null;

// Check if monthly tracking columns exist in the database
// This is called once on first update to gracefully handle cases where migration hasn't been run
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function checkMonthlyTrackingSupport() {
  if (monthlyTrackingEnabled !== null) {
    return monthlyTrackingEnabled; // Already checked
  }
  
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name IN ('requests_this_month', 'last_month_reset_timestamp')
    `);
    
    monthlyTrackingEnabled = result.rows.length === 2;
    
    if (monthlyTrackingEnabled) {
      console.log('✅ Monthly tracking columns detected - monthly tracking enabled');
    } else {
      console.log('⚠️  Monthly tracking columns not found - monthly tracking disabled');
      console.log('   Run: node database_scripts/addMonthlyColumns.js to enable monthly tracking');
    }
    
    return monthlyTrackingEnabled;
  } catch (error) {
    // If we can't check, assume columns don't exist to be safe
    console.error('⚠️  Could not check for monthly tracking columns (non-fatal):', error.message);
    monthlyTrackingEnabled = false;
    return false;
  }
}

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

// Reset all IPs' monthly counters when crossing into a new UTC month
// This handles variable month lengths (28/29/30/31 days) automatically
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function resetMonthlyCounters() {
  try {
    // Check if monthly tracking is supported before attempting reset
    const isSupported = await checkMonthlyTrackingSupport();
    if (!isSupported) {
      return; // Silently skip if columns don't exist
    }
    
    const currentTimestamp = getCurrentUTCTimestamp();
    const currentMonthStart = getStartOfCurrentMonth(currentTimestamp);
    const pool = await getPool();
    
    // If we don't know the last monthly reset time, get it from the database
    if (lastMonthlyReset === null) {
      // Use MIN to get the oldest reset time (the actual global reset)
      // After a global monthly reset, all IPs have the same timestamp
      const result = await pool.query(
        'SELECT MIN(last_month_reset_timestamp) as last_reset FROM ip_table'
      );
      
      if (result.rows.length > 0 && result.rows[0].last_reset) {
        lastMonthlyReset = parseInt(result.rows[0].last_reset);
        console.log(`📅 Synced last monthly reset from database: ${new Date(lastMonthlyReset * 1000).toISOString()}`);
      } else {
        // No IPs in database yet, initialize to start of current month
        lastMonthlyReset = currentMonthStart;
        console.log(`📅 No previous monthly reset found, initializing to start of current month: ${new Date(lastMonthlyReset * 1000).toISOString()}`);
      }
    }
    
    // Check if we've crossed into a new month boundary using proper UTC month comparison
    if (isNewMonth(currentTimestamp, lastMonthlyReset)) {
      const lastMonthDate = new Date(lastMonthlyReset * 1000);
      const currentMonthDate = new Date(currentMonthStart * 1000);
      
      console.log(`📆 Month boundary crossed!`);
      console.log(`   Last reset: ${lastMonthDate.toISOString().substring(0, 7)} (${lastMonthDate.toISOString()})`);
      console.log(`   Current month: ${currentMonthDate.toISOString().substring(0, 7)} (${currentMonthDate.toISOString()})`);
      
      // Reset the monthly counters
      // Set last_month_reset_timestamp to the start of the current month
      const result = await pool.query(
        'UPDATE ip_table SET requests_this_month = 0, last_month_reset_timestamp = $1',
        [currentMonthStart]
      );
      
      lastMonthlyReset = currentMonthStart;
      console.log(`✅ Global monthly reset completed - Reset ${result.rowCount} IPs to month starting at ${currentMonthDate.toISOString()}`);
    }
  } catch (error) {
    // CRITICAL: Catch all errors to prevent crashing the main proxy
    console.error('⚠️  Error during global monthly reset (non-fatal, continuing):', error.message);
    // Reset lastMonthlyReset so we retry fetching from DB next time
    lastMonthlyReset = null;
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
    
    // Always check if we need to do resets, even if no new requests
    // This ensures resets happen on schedule regardless of traffic
    await resetMonthlyCounters();  // Check monthly reset first (less frequent)
    await resetHourlyCounters();   // Then check hourly reset
    
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

      // Check if monthly tracking is supported (only once per update batch)
      const hasMonthlyTracking = await checkMonthlyTrackingSupport();

      for (const ip in ipCountMap) {
        const ipData = ipCountMap[ip];
        const requestCount = ipData.count || 0;
        const origins = ipData.origins || {};

        // Atomic upsert with JSONB merge - handles hourly tracking (and optionally monthly)
        // This query does everything atomically without a read-before-write:
        // 1. Inserts new IP if it doesn't exist (with reset timestamps)
        // 2. Updates existing IP by adding to counters (total, hourly, and monthly if enabled)
        // 3. Merges origins JSONB
        // Note: last_reset_timestamp and last_month_reset_timestamp are only updated during global resets
        
        let query, values;
        const hourlyResetTimestamp = lastGlobalReset || getStartOfCurrentHour(currentTimestamp);
        
        if (hasMonthlyTracking) {
          // Query with monthly tracking columns
          query = `
            INSERT INTO ip_table (
              ip, 
              requests_total, 
              requests_last_hour,
              requests_this_month,
              last_reset_timestamp,
              last_month_reset_timestamp,
              origins
            ) VALUES ($1, $2::bigint, $2::integer, $2::bigint, $3, $4, $5::jsonb)
            ON CONFLICT (ip) DO UPDATE SET
              requests_total = ip_table.requests_total + EXCLUDED.requests_total,
              requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
              requests_this_month = ip_table.requests_this_month + EXCLUDED.requests_this_month,
              origins = COALESCE(ip_table.origins, '{}'::jsonb) || EXCLUDED.origins,
              updated_at = NOW()
            RETURNING requests_total, requests_last_hour, requests_this_month;
          `;
          
          const monthlyResetTimestamp = lastMonthlyReset || getStartOfCurrentMonth(currentTimestamp);
          values = [
            ip,
            requestCount,
            hourlyResetTimestamp,
            monthlyResetTimestamp,
            JSON.stringify(origins)
          ];
        } else {
          // Legacy query without monthly tracking (backwards compatible)
          query = `
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
          
          values = [
            ip,
            requestCount,
            hourlyResetTimestamp,
            JSON.stringify(origins)
          ];
        }

        const result = await client.query(query, values);
        const row = result.rows[0];

        // Log with or without monthly tracking data
        if (hasMonthlyTracking) {
          console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | This Month: ${row.requests_this_month} | Origins: ${JSON.stringify(origins)}`);
        } else {
          console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | Origins: ${JSON.stringify(origins)}`);
        }
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

