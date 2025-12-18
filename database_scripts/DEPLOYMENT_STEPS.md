# Deployment Steps for origins_last_hour Migration

## Quick Summary

This migration adds proper hourly origin tracking to fix the issue where origin counts in `ip_history_table` were showing cumulative totals instead of hourly counts.

## What Was Wrong

- Origin time-series charts showed inflated numbers (1630 requests when system only handled 424 total)
- Root cause: `ip_history_table` was capturing cumulative origin totals, not hourly counts
- Made origin-based time-series analysis unusable

## What This Fixes

- Adds `origins_last_hour` column to track per-origin requests during current hour
- Resets hourly (just like `requests_last_hour`)
- New snapshots in `ip_history_table` will contain correct hourly origin data

## Deployment Steps

### Step 1: Run Migration Script

```bash
cd /home/ubuntu/rpc-ssl-proxy
node database_scripts/addOriginsLastHourColumn.js
```

**Expected output:**
```
✅ Column origins_last_hour added successfully
✅ Verified: origins_last_hour column exists in ip_table
```

**What it does:**
- Adds `origins_last_hour JSONB` column to `ip_table`
- Defaults to `{}`
- Safe to run multiple times (checks if column exists first)

### Step 2: Restart Proxy Service

```bash
# If running as systemd service:
sudo systemctl restart rpc-ssl-proxy

# Or if running with PM2:
pm2 restart rpc-ssl-proxy

# Or if running manually:
# Stop current process and restart
```

**Within 10 seconds** the proxy will auto-detect the new column and log:
```
✅ origins_last_hour column detected - hourly origin tracking enabled
```

### Step 3: Verify (After 1 Hour)

Wait for at least one hourly reset to occur, then check:

```bash
# View live data
node database_scripts/listIpTable.js

# View historical snapshots
node database_scripts/listIpHistoryTable.js
```

**What to look for:**
- `listIpTable.js` will show both cumulative origins and hourly origins
- New snapshots in `ip_history_table` will have correct hourly counts
- Old snapshots (before migration) will still show cumulative totals

## Files Modified

1. ✅ `database_scripts/addOriginsLastHourColumn.js` - Migration script (NEW)
2. ✅ `utils/updateRDSWithIpRequests.js` - Updated to track both columns
3. ✅ `database_scripts/listIpTable.js` - Updated to show new field
4. ✅ `database_scripts/ORIGINS_LAST_HOUR_README.md` - Full documentation (NEW)

## Important Notes

### Backward Compatibility
- ✅ Graceful fallback if column doesn't exist
- ✅ Won't break existing system
- ✅ Proxy continues running even if migration not applied

### Historical Data
- ❌ Old snapshots cannot be retroactively fixed (cumulative data is lost)
- ✅ New snapshots (after migration) will have correct hourly data
- 🔄 You'll see the transition after first hourly reset post-migration

### Time-Series Queries
After migration, your origin time-series queries will work correctly:

```sql
-- This will now show correct hourly counts
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
  hour_timestamp;
```

## Rollback

If you need to rollback (unlikely):

```sql
-- Remove the column
ALTER TABLE ip_table DROP COLUMN IF EXISTS origins_last_hour;
```

The system will automatically detect the missing column and fall back to the old behavior (cumulative origins in snapshots).

## Troubleshooting

### Column exists but not being used
- **Solution:** Restart the proxy to re-detect the column

### origins_last_hour not resetting
- **Check:** Proxy logs for hourly reset messages
- **Manual reset:** `UPDATE ip_table SET origins_last_hour = '{}'::jsonb;`

### Charts still showing wrong data
- **Reason:** Old snapshots contain cumulative data
- **Solution:** Wait for new hourly snapshots to accumulate, or filter queries to only use data after migration timestamp

## Next Steps After Deployment

1. Monitor logs for the first hourly reset
2. Check `listIpTable.js` output to see both origin fields
3. Wait 2-3 hours for clean hourly data to accumulate
4. Test your time-series charts with the new data

## Questions?

See full documentation: `database_scripts/ORIGINS_LAST_HOUR_README.md`
