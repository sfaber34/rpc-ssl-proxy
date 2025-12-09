# Origins Last Hour - Hourly Origin Tracking Fix

## Overview

This migration adds the `origins_last_hour` column to properly track per-origin request counts on an hourly basis. This fixes a critical design flaw where origin counts in `ip_history_table` were cumulative totals instead of hourly counts.

## The Problem

### Before This Fix

The `ip_table` tracked:
- ✅ `requests_total` - cumulative all-time count
- ✅ `requests_last_hour` - hourly count (resets every hour)
- ✅ `requests_this_month` - monthly count (resets every month)
- ❌ `origins` - **cumulative all-time count per origin** (never resets!)

When hourly snapshots were captured to `ip_history_table`, they included:
- ✅ `request_count` - requests in that hour (correct)
- ❌ `origins` - **cumulative totals** at that point in time (wrong for time-series!)

### The Impact

If you queried `ip_history_table` for origin time-series data, you would see:

```
hour_timestamp | origin                      | requests
1734566400     | passkeydemo.atg.eth.link   | 1630  ← WRONG! (cumulative total)
1734570000     | passkeydemo.atg.eth.link   | 1680  ← WRONG! (cumulative total)
```

When the **actual** hourly requests were:
```
hour_timestamp | origin                      | requests
1734566400     | passkeydemo.atg.eth.link   | 50    ← CORRECT (hourly count)
1734570000     | passkeydemo.atg.eth.link   | 50    ← CORRECT (hourly count)
```

This made origin-based time-series charts completely unusable!

## The Solution

### New Column: `origins_last_hour`

```sql
ALTER TABLE ip_table 
ADD COLUMN origins_last_hour JSONB DEFAULT '{}'::jsonb;
```

This column mirrors `requests_last_hour` but for per-origin data:
- Accumulates origin counts during the current hour
- Gets reset to `{}` every hour (synchronized with `requests_last_hour`)
- Gets captured in `ip_history_table` snapshots (providing correct hourly data)

### Data Flow

#### Every 10 Seconds (Request Updates)
```javascript
// Both columns are updated with new requests
origins = origins + new_origins                    // Cumulative (never resets)
origins_last_hour = origins_last_hour + new_origins  // Hourly (resets every hour)
```

#### Every Hour (Hourly Reset)
```javascript
// 1. Capture snapshot to ip_history_table
INSERT INTO ip_history_table (hour_timestamp, ip, request_count, origins)
SELECT hour_timestamp, ip, requests_last_hour, origins_last_hour  -- Use origins_last_hour!
FROM ip_table WHERE requests_last_hour > 0;

// 2. Reset hourly counters
UPDATE ip_table SET 
  requests_last_hour = 0,
  origins_last_hour = '{}'::jsonb;  -- Reset to empty object
```

## Installation

### Step 1: Run the Migration Script

```bash
node database_scripts/addOriginsLastHourColumn.js
```

**What this does:**
- Adds `origins_last_hour` column to `ip_table`
- Sets default value to `{}`
- Checks if column already exists (safe to run multiple times)

**Expected output:**
```
✅ Column origins_last_hour added successfully
✅ Verified: origins_last_hour column exists in ip_table
```

### Step 2: Restart the Proxy

The proxy will automatically:
1. Detect the new column on next update cycle (within 10 seconds)
2. Start tracking hourly origin counts
3. Reset the column every hour
4. Capture correct hourly data in snapshots

**Look for this log message:**
```
✅ origins_last_hour column detected - hourly origin tracking enabled
```

### Step 3: Verify It's Working

After an hour has passed, check the database:

```bash
node database_scripts/listIpHistoryTable.js
```

You should see that new snapshots contain hourly origin counts (not cumulative totals).

## Data Structure

### ip_table (Live Data)

```sql
SELECT ip, requests_total, requests_last_hour, origins, origins_last_hour
FROM ip_table 
WHERE ip = '69.179.195.208';
```

**Example:**
```
ip              | requests_total | requests_last_hour | origins                                  | origins_last_hour
69.179.195.208  | 10500         | 150                | {"passkeydemo.atg.eth.link": 10500}     | {"passkeydemo.atg.eth.link": 150}
```

- `origins`: All-time total (10,500 requests from this origin since tracking began)
- `origins_last_hour`: Current hour total (150 requests from this origin in the current hour)

### ip_history_table (Historical Snapshots)

**After this fix:**
```sql
SELECT hour_timestamp, ip, request_count, origins
FROM ip_history_table 
WHERE ip = '69.179.195.208'
ORDER BY hour_timestamp DESC
LIMIT 3;
```

**Result (new snapshots with correct hourly data):**
```
hour_timestamp | ip              | request_count | origins
1734570000     | 69.179.195.208  | 150          | {"passkeydemo.atg.eth.link": 150}     ← Hourly (correct!)
1734566400     | 69.179.195.208  | 200          | {"passkeydemo.atg.eth.link": 200}     ← Hourly (correct!)
1734562800     | 69.179.195.208  | 10150        | {"passkeydemo.atg.eth.link": 10150}   ← Cumulative (old data)
```

**Note:** Old snapshots (captured before the migration) will still contain cumulative totals. Only new snapshots (captured after migration) will contain correct hourly data.

## Backward Compatibility

The implementation includes graceful fallback:

### If Column Doesn't Exist
- System uses `origins` (cumulative) for snapshots
- Logs warning: `⚠️  origins_last_hour column not found`
- Proxy continues running normally (no crashes)

### If Column Exists
- System uses `origins_last_hour` (hourly) for snapshots
- Logs confirmation: `✅ origins_last_hour column detected`
- Both `origins` (cumulative) and `origins_last_hour` (hourly) are tracked

## Querying Time-Series Data

### After Migration (Correct Hourly Data)

```sql
-- Get hourly origin activity for time-series charts
SELECT 
  hour_timestamp,
  origin_key AS origin,
  SUM((origin_value)::int) AS hourly_requests
FROM 
  ip_history_table,
  jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
WHERE 
  hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
GROUP BY 
  hour_timestamp, origin_key
ORDER BY 
  hour_timestamp, origin_key;
```

**Result:**
```
hour_timestamp | origin                      | hourly_requests
1734566400     | passkeydemo.atg.eth.link   | 150    ← Actual hourly count
1734570000     | passkeydemo.atg.eth.link   | 200    ← Actual hourly count
1734573600     | passkeydemo.atg.eth.link   | 175    ← Actual hourly count
```

### Handling Mixed Data (Old + New Snapshots)

If you need to query data that spans both before and after the migration:

```sql
-- Only use data from after the migration was deployed
-- (Exclude old cumulative data)
SELECT 
  hour_timestamp,
  origin_key AS origin,
  SUM((origin_value)::int) AS hourly_requests
FROM 
  ip_history_table,
  jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
WHERE 
  hour_timestamp >= 1734566400  -- Replace with timestamp of migration deployment
GROUP BY 
  hour_timestamp, origin_key
ORDER BY 
  hour_timestamp, origin_key;
```

## Monitoring

### Check if Migration Was Applied

```bash
# Query the database directly
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "
  SELECT column_name, data_type, column_default
  FROM information_schema.columns 
  WHERE table_name = 'ip_table' 
  AND column_name IN ('origins', 'origins_last_hour');
"
```

**Expected output:**
```
column_name        | data_type | column_default
origins            | jsonb     | '{}'::jsonb
origins_last_hour  | jsonb     | '{}'::jsonb
```

### Watch Logs for Confirmation

```bash
# After restarting proxy, look for these messages:
✅ origins_last_hour column detected - hourly origin tracking enabled
📸 Capturing hourly snapshot: 150 active IPs for hour 2025-12-09T15:00:00.000Z
   Using hourly origin data
```

### Verify Hourly Resets

```sql
-- Check if origins_last_hour is being reset (should be small numbers)
SELECT 
  ip, 
  requests_last_hour,
  origins_last_hour
FROM ip_table 
WHERE requests_last_hour > 0
LIMIT 10;
```

If `origins_last_hour` values are small (similar to `requests_last_hour`), it's working correctly.
If values are large (similar to cumulative `origins`), the reset isn't happening.

## Troubleshooting

### Column Exists But Not Being Used

**Symptoms:**
- Column is present in database
- Proxy logs show: `⚠️  origins_last_hour column not found`

**Solution:**
- Restart the proxy to re-detect the column
- Check if `originsLastHourEnabled` flag needs to be reset

### Origins_last_hour Not Resetting

**Symptoms:**
- `origins_last_hour` values keep growing
- Values match `origins` (cumulative)

**Solution:**
- Check proxy logs for hourly reset messages
- Verify resetHourlyCounters is running
- Manually reset: `UPDATE ip_table SET origins_last_hour = '{}'::jsonb;`

### Historical Data Still Shows Cumulative

**Symptoms:**
- New queries still show inflated origin counts
- Time-series charts still incorrect

**Issue:**
- Old snapshots contain cumulative data (can't be fixed retroactively)

**Solution:**
- Wait for new hourly snapshots to accumulate
- Filter queries to only use data after migration timestamp
- Consider clearing old snapshots: `DELETE FROM ip_history_table WHERE hour_timestamp < <migration_timestamp>;`

## Performance Impact

### Storage
- **Negligible** - JSONB is efficient, adds ~100-500 bytes per IP
- Same size as existing `origins` column

### CPU
- **Minimal** - Same merge operations as `origins`
- Uses `jsonb_merge_add_numeric()` function (already optimized)

### Memory
- **None** - No new in-memory structures
- Data stays in PostgreSQL

## Related Files

- **Migration script:** `database_scripts/addOriginsLastHourColumn.js`
- **Update logic:** `utils/updateRDSWithIpRequests.js`
- **Table schema:** `database_scripts/createIpTable.js` (doesn't include this column by default)
- **History tracking:** `database_scripts/createIpHistoryTable.js` (unchanged)

## Future Considerations

### Option 1: Update createIpTable.js
Add `origins_last_hour` to the default schema so new installations include it.

### Option 2: Create origin_history_table
If you need frequent origin-specific queries, consider normalizing origin data into a separate table (as discussed earlier).

### Option 3: Backfill Historical Data
If you need accurate historical data, you could:
1. Calculate deltas between consecutive snapshots
2. Create a new table with corrected hourly data
3. Use LAG() window functions to compute differences

## Summary

### Before Fix
- ❌ Origin time-series data was unusable
- ❌ `ip_history_table` contained cumulative totals
- ❌ Charts showed inflated numbers (10x-100x too high)

### After Fix
- ✅ Origin time-series data is accurate
- ✅ `ip_history_table` contains hourly counts
- ✅ Charts show correct hourly activity
- ✅ Both cumulative and hourly data are tracked
- ✅ Backward compatible (graceful fallback)

---

**Status:** ✅ **IMPLEMENTED** - Hourly origin tracking now works correctly
**Date:** December 9, 2025
**Migration Required:** Yes - Run `addOriginsLastHourColumn.js`
**Breaking Changes:** None (backward compatible)
