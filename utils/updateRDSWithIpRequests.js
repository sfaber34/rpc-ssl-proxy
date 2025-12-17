import { getPool } from './postgresClient.js';
import { filterOrigins } from './originValidator.js';

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

// Flag to track if the custom origin merge function exists
// This prevents errors if the function hasn't been created yet
let originMergeFunctionExists = null;

// Flag to track if origins_last_hour column exists in the database
// This prevents errors if the migration hasn't been run yet
let originsLastHourEnabled = null;

// Flag to track if sliding window columns exist (requests_previous_hour, origins_previous_hour)
let slidingWindowEnabled = null;

// Flag to track if daily limit columns exist (requests_today, origins_today, last_day_reset_timestamp)
let dailyLimitEnabled = null;

// Store the last daily reset time in memory (will be synced from DB)
let lastDailyReset = null;

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

// Check if the custom jsonb_merge_add_numeric function exists in the database
// This function properly adds origin counts instead of overwriting them
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function checkOriginMergeFunctionExists() {
  if (originMergeFunctionExists !== null) {
    return originMergeFunctionExists; // Already checked
  }
  
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.proname = 'jsonb_merge_add_numeric'
      ) as exists
    `);
    
    originMergeFunctionExists = result.rows[0]?.exists || false;
    
    if (originMergeFunctionExists) {
      console.log('✅ Custom origin merge function detected - origin counts will accumulate correctly');
    } else {
      console.log('⚠️  Custom origin merge function not found - using fallback (origins will overwrite)');
      console.log('   Run: node database_scripts/createOriginMergeFunction.js to enable proper origin tracking');
      console.log('   ⚠️  WARNING: Without this function, origin counts will be incorrect!');
    }
    
    return originMergeFunctionExists;
  } catch (error) {
    // If we can't check, assume function doesn't exist and use fallback
    console.error('⚠️  Could not check for origin merge function (non-fatal):', error.message);
    originMergeFunctionExists = false;
    return false;
  }
}

// Check if origins_last_hour column exists in the database
// This column tracks per-origin request counts for the current hour (resets hourly)
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function checkOriginsLastHourSupport() {
  if (originsLastHourEnabled !== null) {
    return originsLastHourEnabled; // Already checked
  }
  
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name = 'origins_last_hour'
    `);
    
    originsLastHourEnabled = result.rows.length === 1;
    
    if (originsLastHourEnabled) {
      console.log('✅ origins_last_hour column detected - hourly origin tracking enabled');
    } else {
      console.log('⚠️  origins_last_hour column not found - hourly origin tracking disabled');
      console.log('   Run: node database_scripts/addOriginsLastHourColumn.js to enable hourly origin tracking');
      console.log('   ⚠️  WARNING: ip_history_table will contain cumulative origin counts (not hourly)!');
    }
    
    return originsLastHourEnabled;
  } catch (error) {
    // If we can't check, assume column doesn't exist to be safe
    console.error('⚠️  Could not check for origins_last_hour column (non-fatal):', error.message);
    originsLastHourEnabled = false;
    return false;
  }
}

// Check if sliding window columns exist (requests_previous_hour, origins_previous_hour)
// These columns enable the sliding window rate limit approximation
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function checkSlidingWindowSupport() {
  if (slidingWindowEnabled !== null) {
    return slidingWindowEnabled; // Already checked
  }
  
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name IN ('requests_previous_hour', 'origins_previous_hour')
    `);
    
    slidingWindowEnabled = result.rows.length === 2;
    
    if (slidingWindowEnabled) {
      console.log('✅ Sliding window columns detected - sliding window rate limiting enabled');
    } else {
      console.log('⚠️  Sliding window columns not found - using fixed window rate limiting');
      console.log('   Run: node database_scripts/addSlidingWindowColumns.js to enable sliding window');
    }
    
    return slidingWindowEnabled;
  } catch (error) {
    console.error('⚠️  Could not check for sliding window columns (non-fatal):', error.message);
    slidingWindowEnabled = false;
    return false;
  }
}

// Check if daily limit columns exist (requests_today, origins_today, last_day_reset_timestamp)
// These columns enable daily rate limiting as a secondary protection
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function checkDailyLimitSupport() {
  if (dailyLimitEnabled !== null) {
    return dailyLimitEnabled; // Already checked
  }
  
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ip_table' 
      AND column_name IN ('requests_today', 'origins_today', 'last_day_reset_timestamp')
    `);
    
    dailyLimitEnabled = result.rows.length === 3;
    
    if (dailyLimitEnabled) {
      console.log('✅ Daily limit columns detected - daily rate limiting enabled');
    } else {
      console.log('⚠️  Daily limit columns not found - daily rate limiting disabled');
      console.log('   Run: node database_scripts/addDailyLimitColumns.js to enable daily limits');
    }
    
    return dailyLimitEnabled;
  } catch (error) {
    console.error('⚠️  Could not check for daily limit columns (non-fatal):', error.message);
    dailyLimitEnabled = false;
    return false;
  }
}

// Helper function to get the start of the current day in UTC (midnight)
// Returns Unix timestamp in seconds
function getStartOfCurrentDay(timestamp) {
  return Math.floor(timestamp / 86400) * 86400;
}

// Helper function to check if we're in a different day than the reset timestamp
function isNewDay(currentTimestamp, lastResetTimestamp) {
  const currentDay = getStartOfCurrentDay(currentTimestamp);
  const resetDay = getStartOfCurrentDay(lastResetTimestamp);
  return currentDay > resetDay;
}

// Capture hourly snapshot to ip_history_table before resetting counters
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function captureHourlySnapshot(hourTimestamp) {
  try {
    const pool = await getPool();
    
    // Check if origins_last_hour column exists
    const hasOriginsLastHour = await checkOriginsLastHourSupport();
    
    // Query all IPs with activity in the last hour
    // Use origins_last_hour if available (correct hourly data), otherwise fall back to origins (cumulative)
    const originColumn = hasOriginsLastHour ? 'origins_last_hour' : 'origins';
    const snapshotQuery = `
      SELECT ip, requests_last_hour, ${originColumn} as origins
      FROM ip_table
      WHERE requests_last_hour > 0
    `;
    
    const result = await pool.query(snapshotQuery);
    
    if (result.rows.length === 0) {
      console.log('📸 No active IPs in last hour - skipping history snapshot');
      return;
    }
    
    const dataType = hasOriginsLastHour ? 'hourly origin data' : 'cumulative origin data (⚠️ not accurate for time-series)';
    console.log(`📸 Capturing hourly snapshot: ${result.rows.length} active IPs for hour ${new Date(hourTimestamp * 1000).toISOString()}`);
    console.log(`   Using ${dataType}`);
    
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
// With sliding window support, this SHIFTS current hour data to previous hour before resetting
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
      
      // STEP 2: Shift current hour data to previous hour, then reset current hour
      // This enables the sliding window rate limit approximation
      const hasOriginsLastHour = await checkOriginsLastHourSupport();
      const hasSlidingWindow = await checkSlidingWindowSupport();
      
      let resetQuery, result;
      
      if (hasSlidingWindow && hasOriginsLastHour) {
        // Full sliding window support: shift all data
        // If more than 1 hour passed, previous hour data becomes 0 (stale)
        if (hoursPassed > 1) {
          resetQuery = `
            UPDATE ip_table 
            SET requests_previous_hour = 0,
                origins_previous_hour = '{}'::jsonb,
                requests_last_hour = 0, 
                origins_last_hour = '{}'::jsonb,
                last_reset_timestamp = $1
          `;
          console.log(`   (${hoursPassed.toFixed(0)} hours gap - clearing previous hour data too)`);
        } else {
          resetQuery = `
            UPDATE ip_table 
            SET requests_previous_hour = requests_last_hour,
                origins_previous_hour = COALESCE(origins_last_hour, '{}'::jsonb),
                requests_last_hour = 0, 
                origins_last_hour = '{}'::jsonb,
                last_reset_timestamp = $1
          `;
        }
        result = await pool.query(resetQuery, [currentHourStart]);
        console.log(`✅ Hourly reset with sliding window shift - ${result.rowCount} IPs updated at ${new Date(currentHourStart * 1000).toISOString()}`);
        
      } else if (hasSlidingWindow) {
        // Sliding window for IP counts only (no origins_last_hour column)
        if (hoursPassed > 1) {
          resetQuery = `
            UPDATE ip_table 
            SET requests_previous_hour = 0,
                origins_previous_hour = '{}'::jsonb,
                requests_last_hour = 0,
                last_reset_timestamp = $1
          `;
        } else {
          resetQuery = `
            UPDATE ip_table 
            SET requests_previous_hour = requests_last_hour,
                requests_last_hour = 0,
                last_reset_timestamp = $1
          `;
        }
        result = await pool.query(resetQuery, [currentHourStart]);
        console.log(`✅ Hourly reset with sliding window shift (IP only) - ${result.rowCount} IPs at ${new Date(currentHourStart * 1000).toISOString()}`);
        
      } else if (hasOriginsLastHour) {
        // Legacy: origins_last_hour but no sliding window
        resetQuery = `
          UPDATE ip_table 
          SET requests_last_hour = 0, 
              origins_last_hour = '{}'::jsonb,
              last_reset_timestamp = $1
        `;
        result = await pool.query(resetQuery, [currentHourStart]);
        console.log(`✅ Hourly reset (fixed window) - ${result.rowCount} IPs at ${new Date(currentHourStart * 1000).toISOString()}`);
        
      } else {
        // Most basic: no origins_last_hour, no sliding window
        resetQuery = 'UPDATE ip_table SET requests_last_hour = 0, last_reset_timestamp = $1';
        result = await pool.query(resetQuery, [currentHourStart]);
        console.log(`✅ Hourly reset (basic) - ${result.rowCount} IPs at ${new Date(currentHourStart * 1000).toISOString()}`);
      }
      
      lastGlobalReset = currentHourStart;
      
      // STEP 3: Run daily cleanup if needed
      await cleanupOldHistory();
    }
  } catch (error) {
    console.error('❌ Error during global hourly reset:', error);
    // Reset lastGlobalReset so we retry fetching from DB next time
    lastGlobalReset = null;
  }
}

// Reset all IPs' daily counters when crossing into a new UTC day
// CRITICAL: This function MUST NOT throw errors - wrapped in try-catch to protect main proxy
async function resetDailyCounters() {
  try {
    // Check if daily limit tracking is supported before attempting reset
    const isSupported = await checkDailyLimitSupport();
    if (!isSupported) {
      return; // Silently skip if columns don't exist
    }
    
    const currentTimestamp = getCurrentUTCTimestamp();
    const currentDayStart = getStartOfCurrentDay(currentTimestamp);
    const pool = await getPool();
    
    // If we don't know the last daily reset time, get it from the database
    if (lastDailyReset === null) {
      const result = await pool.query(
        'SELECT MIN(last_day_reset_timestamp) as last_reset FROM ip_table'
      );
      
      if (result.rows.length > 0 && result.rows[0].last_reset) {
        lastDailyReset = parseInt(result.rows[0].last_reset);
        console.log(`📅 Synced last daily reset from database: ${new Date(lastDailyReset * 1000).toISOString()}`);
      } else {
        // No IPs in database yet, initialize to start of current day
        lastDailyReset = currentDayStart;
        console.log(`📅 No previous daily reset found, initializing to: ${new Date(lastDailyReset * 1000).toISOString()}`);
      }
    }
    
    // Check if we've crossed into a new day boundary
    if (isNewDay(currentTimestamp, lastDailyReset)) {
      const lastDayDate = new Date(lastDailyReset * 1000);
      const currentDayDate = new Date(currentDayStart * 1000);
      
      console.log(`📆 Day boundary crossed!`);
      console.log(`   Last reset: ${lastDayDate.toISOString().substring(0, 10)}`);
      console.log(`   Current day: ${currentDayDate.toISOString().substring(0, 10)}`);
      
      // Reset the daily counters
      const result = await pool.query(`
        UPDATE ip_table 
        SET requests_today = 0, 
            origins_today = '{}'::jsonb,
            last_day_reset_timestamp = $1
      `, [currentDayStart]);
      
      lastDailyReset = currentDayStart;
      console.log(`✅ Daily reset completed - Reset ${result.rowCount} IPs for day starting at ${currentDayDate.toISOString()}`);
    }
  } catch (error) {
    // CRITICAL: Catch all errors to prevent crashing the main proxy
    console.error('⚠️  Error during daily reset (non-fatal, continuing):', error.message);
    // Reset lastDailyReset so we retry fetching from DB next time
    lastDailyReset = null;
    // Do NOT throw - we want the main proxy to continue running
  }
}

async function updateRDSWithIpRequests(ipCountMap) {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    
    // Always check if we need to do resets, even if no new requests
    // This ensures resets happen on schedule regardless of traffic
    await resetMonthlyCounters();  // Check monthly reset first (less frequent)
    await resetDailyCounters();    // Check daily reset
    await resetHourlyCounters();   // Then check hourly reset (most frequent)
    
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
      
      // Check if custom origin merge function exists (only once per update batch)
      const hasOriginMergeFunction = await checkOriginMergeFunctionExists();
      
      // Check if origins_last_hour column exists (only once per update batch)
      const hasOriginsLastHour = await checkOriginsLastHourSupport();
      
      // Check if daily limit columns exist (only once per update batch)
      const hasDailyLimit = await checkDailyLimitSupport();

      for (const ip in ipCountMap) {
        const ipData = ipCountMap[ip];
        const requestCount = ipData.count || 0;
        
        // Filter out local/test origins before database write
        // CRITICAL: Wrapped in try-catch to prevent filtering errors from breaking database writes
        let origins = {};
        try {
          const rawOrigins = ipData.origins || {};
          origins = filterOrigins(rawOrigins);
          
          // Log if origins were filtered out
          const originalCount = Object.keys(rawOrigins).length;
          const filteredCount = Object.keys(origins).length;
          if (originalCount > filteredCount) {
            console.log(`🔒 IP ${ip}: Filtered ${originalCount - filteredCount} local origin(s), keeping ${filteredCount} real domain(s)`);
          }
        } catch (filterError) {
          // If filtering fails completely, use empty origins (safe fallback)
          console.error(`⚠️  Origin filtering failed for IP ${ip} - using empty origins:`, filterError.message);
          origins = {};
        }

        // Atomic upsert with JSONB merge - handles hourly tracking (and optionally monthly)
        // This query does everything atomically without a read-before-write:
        // 1. Inserts new IP if it doesn't exist (with reset timestamps)
        // 2. Updates existing IP by adding to counters (total, hourly, and monthly if enabled)
        // 3. Merges origins JSONB (using custom function to ADD counts, or || operator as fallback)
        // Note: last_reset_timestamp and last_month_reset_timestamp are only updated during global resets
        
        let query, values;
        const hourlyResetTimestamp = lastGlobalReset || getStartOfCurrentHour(currentTimestamp);
        
        try {
          if (hasMonthlyTracking) {
            // Query with monthly tracking columns
            // Use custom merge function if available, otherwise fall back to || operator
            if (hasOriginsLastHour) {
              // With origins_last_hour column - track both cumulative and hourly origins
              if (hasOriginMergeFunction) {
                query = `
                  INSERT INTO ip_table (
                    ip, 
                    requests_total, 
                    requests_last_hour,
                    requests_this_month,
                    last_reset_timestamp,
                    last_month_reset_timestamp,
                    origins,
                    origins_last_hour
                  ) VALUES ($1, $2::bigint, $2::integer, $2::bigint, $3, $4, $5::jsonb, $5::jsonb)
                  ON CONFLICT (ip) DO UPDATE SET
                    requests_total = ip_table.requests_total + EXCLUDED.requests_total,
                    requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
                    requests_this_month = ip_table.requests_this_month + EXCLUDED.requests_this_month,
                    origins = jsonb_merge_add_numeric(COALESCE(ip_table.origins, '{}'::jsonb), EXCLUDED.origins),
                    origins_last_hour = jsonb_merge_add_numeric(COALESCE(ip_table.origins_last_hour, '{}'::jsonb), EXCLUDED.origins_last_hour),
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour, requests_this_month;
                `;
              } else {
                query = `
                  INSERT INTO ip_table (
                    ip, 
                    requests_total, 
                    requests_last_hour,
                    requests_this_month,
                    last_reset_timestamp,
                    last_month_reset_timestamp,
                    origins,
                    origins_last_hour
                  ) VALUES ($1, $2::bigint, $2::integer, $2::bigint, $3, $4, $5::jsonb, $5::jsonb)
                  ON CONFLICT (ip) DO UPDATE SET
                    requests_total = ip_table.requests_total + EXCLUDED.requests_total,
                    requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
                    requests_this_month = ip_table.requests_this_month + EXCLUDED.requests_this_month,
                    origins = COALESCE(ip_table.origins, '{}'::jsonb) || EXCLUDED.origins,
                    origins_last_hour = COALESCE(ip_table.origins_last_hour, '{}'::jsonb) || EXCLUDED.origins_last_hour,
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour, requests_this_month;
                `;
              }
            } else {
              // Without origins_last_hour column - legacy behavior
              if (hasOriginMergeFunction) {
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
                    origins = jsonb_merge_add_numeric(COALESCE(ip_table.origins, '{}'::jsonb), EXCLUDED.origins),
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour, requests_this_month;
                `;
              } else {
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
              }
            }
            
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
            // Use custom merge function if available, otherwise fall back to || operator
            if (hasOriginsLastHour) {
              // With origins_last_hour column - track both cumulative and hourly origins
              if (hasOriginMergeFunction) {
                query = `
                  INSERT INTO ip_table (
                    ip, 
                    requests_total, 
                    requests_last_hour,
                    last_reset_timestamp,
                    origins,
                    origins_last_hour
                  ) VALUES ($1, $2::bigint, $2::integer, $3, $4::jsonb, $4::jsonb)
                  ON CONFLICT (ip) DO UPDATE SET
                    requests_total = ip_table.requests_total + EXCLUDED.requests_total,
                    requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
                    origins = jsonb_merge_add_numeric(COALESCE(ip_table.origins, '{}'::jsonb), EXCLUDED.origins),
                    origins_last_hour = jsonb_merge_add_numeric(COALESCE(ip_table.origins_last_hour, '{}'::jsonb), EXCLUDED.origins_last_hour),
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour;
                `;
              } else {
                query = `
                  INSERT INTO ip_table (
                    ip, 
                    requests_total, 
                    requests_last_hour,
                    last_reset_timestamp,
                    origins,
                    origins_last_hour
                  ) VALUES ($1, $2::bigint, $2::integer, $3, $4::jsonb, $4::jsonb)
                  ON CONFLICT (ip) DO UPDATE SET
                    requests_total = ip_table.requests_total + EXCLUDED.requests_total,
                    requests_last_hour = ip_table.requests_last_hour + EXCLUDED.requests_last_hour,
                    origins = COALESCE(ip_table.origins, '{}'::jsonb) || EXCLUDED.origins,
                    origins_last_hour = COALESCE(ip_table.origins_last_hour, '{}'::jsonb) || EXCLUDED.origins_last_hour,
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour;
                `;
              }
            } else {
              // Without origins_last_hour column - legacy behavior
              if (hasOriginMergeFunction) {
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
                    origins = jsonb_merge_add_numeric(COALESCE(ip_table.origins, '{}'::jsonb), EXCLUDED.origins),
                    updated_at = NOW()
                  RETURNING requests_total, requests_last_hour;
                `;
              } else {
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
              }
            }
            
            values = [
              ip,
              requestCount,
              hourlyResetTimestamp,
              JSON.stringify(origins)
            ];
          }

          const result = await client.query(query, values);
          const row = result.rows[0];
          
          // Update daily counters if that feature is enabled
          // This is done as a separate update to avoid making the main upsert query even more complex
          if (hasDailyLimit) {
            try {
              const dailyQuery = hasOriginMergeFunction 
                ? `
                  UPDATE ip_table 
                  SET requests_today = requests_today + $2,
                      origins_today = jsonb_merge_add_numeric(COALESCE(origins_today, '{}'::jsonb), $3::jsonb)
                  WHERE ip = $1
                `
                : `
                  UPDATE ip_table 
                  SET requests_today = requests_today + $2,
                      origins_today = COALESCE(origins_today, '{}'::jsonb) || $3::jsonb
                  WHERE ip = $1
                `;
              await client.query(dailyQuery, [ip, requestCount, JSON.stringify(origins)]);
            } catch (dailyError) {
              // Non-fatal - log and continue (daily tracking is optional enhancement)
              console.error(`⚠️  Failed to update daily counters for IP ${ip}:`, dailyError.message);
            }
          }

          // Log with or without monthly tracking data
          if (hasMonthlyTracking) {
            console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | This Month: ${row.requests_this_month} | Origins: ${JSON.stringify(origins)}`);
          } else {
            console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${row.requests_total} | Last Hour: ${row.requests_last_hour} | Origins: ${JSON.stringify(origins)}`);
          }
          updateCount++;
          
        } catch (queryError) {
          // Handle individual query errors gracefully without stopping the batch
          console.error(`⚠️  Failed to update IP ${ip}:`, {
            error: queryError.message,
            code: queryError.code,
            ip: ip,
            requestCount: requestCount
          });
          
          // If this is the first IP and the error is about the merge function,
          // reset the flag and try again with fallback on next batch
          if (updateCount === 0 && queryError.message?.includes('jsonb_merge_add_numeric')) {
            console.error('⚠️  Origin merge function failed - will use fallback on next update');
            originMergeFunctionExists = null; // Reset to re-check next time
          }
          
          // Continue with other IPs instead of failing the entire batch
          continue;
        }
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

