# Database Scripts

This directory contains PostgreSQL database management scripts for the RPC SSL Proxy.

## Prerequisites

- AWS RDS PostgreSQL database configured
- Environment variables set in `.env`:
  - `RDS_SECRET_NAME`
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `DB_HOST`
- RDS CA bundle at `/home/ubuntu/shared/rds-ca-bundle.pem`

## Scripts

### 🔧 createOriginMergeFunction.js

**CRITICAL:** Creates a custom PostgreSQL function to fix origin tracking bug.

**What it fixes:**
- Origin counts were being **overwritten** instead of **accumulated**
- This caused massive data loss (99%+ of origin tracking data)
- Example: IP with 10,000 requests showed only 6 requests per origin

**What it does:**
- Creates `jsonb_merge_add_numeric()` function that properly **adds** origin counts
- Includes comprehensive error handling and NULL safety
- Runs automated tests to verify correct behavior
- Self-healing: existing data will naturally correct itself after installation

**Usage:**
```bash
node database_scripts/createOriginMergeFunction.js
```

✅ **Safe to run multiple times** - Uses `CREATE OR REPLACE`

**See also:** `ORIGIN_TRACKING_FIX.md` for detailed documentation

---

### createIpTable.js

Creates the `ip_table` for tracking IP request statistics.

**Schema:**
- `ip` (VARCHAR(45), PRIMARY KEY) - IP address
- `requests_total` (BIGINT) - Total requests from this IP (all time)
- `requests_last_hour` (INTEGER) - Requests in the current hour
- `requests_this_month` (BIGINT) - Requests in the current month (UTC)
- `last_reset_timestamp` (BIGINT) - Unix timestamp of last hourly reset
- `last_month_reset_timestamp` (BIGINT) - Unix timestamp of last monthly reset
- `origins` (JSONB) - Map of origin domains to request counts
- `updated_at` (TIMESTAMP) - Last update timestamp

**Usage:**
```bash
node database_scripts/createIpTable.js
```

⚠️ **Warning:** This will DROP the existing table if it exists. You will be prompted for confirmation.

### addMonthlyColumns.js

Adds monthly request tracking to an existing `ip_table` without losing data.

**What it does:**
- Adds `requests_this_month` column (BIGINT, tracks current month requests)
- Adds `last_month_reset_timestamp` column (BIGINT, tracks UTC month boundaries)
- Initializes all existing rows to the start of the current UTC month

**Usage:**
```bash
node database_scripts/addMonthlyColumns.js
```

✅ **Safe Migration:** This is a non-destructive migration that preserves all existing data.

### listIpTable.js

Lists the contents of the `ip_table` with statistics.

**Features:**
- Shows top 100 IPs by total requests
- Displays total statistics
- Shows top 5 most active IPs in the last hour
- Pretty-formatted output with origins preview

**Usage:**
```bash
node database_scripts/listIpTable.js
```

## Table Design Notes

The `ip_table` is optimized for high-frequency writes with:
- Indexed `last_reset_timestamp` for efficient hourly reset queries
- Indexed `updated_at` for monitoring
- JSONB `origins` field for flexible origin tracking
- Supports atomic upserts with `ON CONFLICT DO UPDATE`

This design eliminates the read-before-write pattern required by Firestore, significantly improving performance and reducing costs.

### Request Tracking Features

**Hourly Tracking:**
- `requests_last_hour` resets every hour at UTC hour boundaries (e.g., 14:00:00 UTC)
- `last_reset_timestamp` stores the start of the current hour
- Global reset ensures all IPs reset simultaneously

**Monthly Tracking:**
- `requests_this_month` resets at the start of each UTC month (e.g., 2025-12-01 00:00:00 UTC)
- `last_month_reset_timestamp` stores the start of the current month
- Handles variable month lengths automatically (28/29/30/31 days)
- Global reset ensures all IPs reset simultaneously

Both tracking systems use UTC timestamps and proper date boundaries to ensure reliable rollover detection.

**Origin Tracking:**
- `origins` (JSONB) stores per-origin request counts as `{"origin.com": count}`
- Uses custom `jsonb_merge_add_numeric()` function to properly accumulate counts
- Falls back to `||` operator if function not available (with warning)
- See `ORIGIN_TRACKING_FIX.md` for details on the critical bug fix

## Quick Start

### Initial Setup (New Database)

1. Create the IP table:
   ```bash
   node database_scripts/createIpTable.js
   ```

2. Create the origin merge function (CRITICAL):
   ```bash
   node database_scripts/createOriginMergeFunction.js
   ```

3. Create the IP history table (optional, for time-series data):
   ```bash
   node database_scripts/createIpHistoryTable.js
   ```

### Existing Database Migration

If you already have an `ip_table`:

1. Add monthly tracking (if not already done):
   ```bash
   node database_scripts/addMonthlyColumns.js
   ```

2. **CRITICAL:** Install the origin merge function:
   ```bash
   node database_scripts/createOriginMergeFunction.js
   ```
   
   Without this function, origin counts will be incorrect!

## Troubleshooting

### Origin Counts Stuck at Low Numbers

If you see origin counts that don't match log activity:
1. Run `node database_scripts/createOriginMergeFunction.js`
2. Restart the proxy (or wait 10 seconds for auto-detection)
3. Watch logs for: `✅ Custom origin merge function detected`
4. Data will self-heal within hours

See `ORIGIN_TRACKING_FIX.md` for detailed troubleshooting.

