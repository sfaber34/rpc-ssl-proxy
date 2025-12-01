# IP History Table - Implementation Guide

## Overview
The `ip_history_table` stores hourly snapshots of IP request counts for time-series analysis and plotting. Data is retained for 30 days with automatic cleanup.

## Table Schema

```sql
CREATE TABLE ip_history_table (
  id SERIAL PRIMARY KEY,
  hour_timestamp BIGINT NOT NULL,           -- UTC epoch for START of hour
  ip VARCHAR(45) NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  origins JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Indexes:**
- `idx_history_timestamp` - Fast time-range queries
- `idx_history_ip_timestamp` - Filter by IP + time
- `idx_history_timestamp_ip` - Time-series queries
- `idx_history_unique_hour_ip` - UNIQUE constraint (hour_timestamp, ip)

## How It Works

### Data Flow
```
Every 10 seconds:
  └─ updateRDSWithIpRequests() runs
      └─ resetHourlyCounters() checks if hour has passed
          └─ IF hour >= 1:
              1. captureHourlySnapshot() - Save current ip_table data to history
              2. Reset ip_table counters to 0
              3. cleanupOldHistory() - Delete data older than 30 days (once per day)
```

### Timing
- **Snapshot Capture**: Once per hour (when hourly reset triggers)
- **Data Source**: Reads from existing `ip_table.requests_last_hour`
- **Timestamp**: Uses `lastGlobalReset` (UTC epoch for start of completed hour)
- **Cleanup**: Once per 24 hours

### Error Handling
**CRITICAL**: All history operations are wrapped in try-catch blocks:
- Errors are logged but **NEVER thrown**
- Main proxy continues running even if history features fail
- Individual IP insert failures don't stop the batch

## Database Scripts

### 1. Create Table
```bash
node database_scripts/createIpHistoryTable.js
```
Creates the table with schema and indexes. **WARNING**: Drops existing table!

### 2. View History
```bash
node database_scripts/listIpHistoryTable.js
```
Shows:
- Statistics (total records, unique hours/IPs, date range)
- Last 24 hours of data (top 100 records)
- Top 5 most active IPs
- Warning if cleanup needed

### 3. Manual Cleanup
```bash
node database_scripts/deleteOldIpHistory.js
```
Manually delete records older than 30 days. Usually not needed (automatic cleanup runs daily).

## Usage for Time-Series Plotting

### Query Example: Last 24 Hours
```sql
SELECT hour_timestamp, ip, request_count 
FROM ip_history_table 
WHERE hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
ORDER BY hour_timestamp, ip;
```

### Query Example: Specific IP Over Time
```sql
SELECT 
  hour_timestamp,
  request_count,
  origins
FROM ip_history_table 
WHERE ip = '123.45.67.89'
  AND hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days')
ORDER BY hour_timestamp;
```

### Query Example: Top IPs Per Hour
```sql
SELECT 
  hour_timestamp,
  ip,
  request_count,
  ROW_NUMBER() OVER (PARTITION BY hour_timestamp ORDER BY request_count DESC) as rank
FROM ip_history_table
WHERE hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
ORDER BY hour_timestamp, rank
LIMIT 100;
```

## Data Structure for Plotting

### Format for Chart Libraries (Chart.js, D3, etc.)
```javascript
// Group by IP for multi-line time series
const dataByIp = {};

results.forEach(row => {
  if (!dataByIp[row.ip]) {
    dataByIp[row.ip] = {
      label: row.ip,
      data: []
    };
  }
  dataByIp[row.ip].data.push({
    x: row.hour_timestamp * 1000, // Convert to milliseconds for JS Date
    y: row.request_count
  });
});

// Convert to array for chart
const datasets = Object.values(dataByIp);
```

## Storage Estimates

- **1000 IPs/hour**: ~100KB/hour, ~2.4MB/day, ~72MB/month
- **5000 IPs/hour**: ~500KB/hour, ~12MB/day, ~360MB/month
- **10000 IPs/hour**: ~1MB/hour, ~24MB/day, ~720MB/month

With 30-day retention, storage is very manageable.

## Monitoring

### Check Table Size
```sql
SELECT 
  pg_size_pretty(pg_total_relation_size('ip_history_table')) as total_size,
  COUNT(*) as total_records,
  COUNT(DISTINCT hour_timestamp) as unique_hours,
  COUNT(DISTINCT ip) as unique_ips
FROM ip_history_table;
```

### Check Latest Snapshot
```sql
SELECT 
  MAX(hour_timestamp) as latest_hour,
  COUNT(*) as ips_in_latest_hour
FROM ip_history_table
WHERE hour_timestamp = (SELECT MAX(hour_timestamp) FROM ip_history_table);
```

## Troubleshooting

### No Data Being Captured
- Check logs for "📸 Capturing hourly snapshot" messages
- Verify `ip_table` has records with `requests_last_hour > 0`
- Check for error messages starting with "⚠️"

### Cleanup Not Running
- Check logs for "🧹 Running daily cleanup" messages
- Verify 24+ hours have passed since last cleanup
- Run manual cleanup script if needed

### Duplicate Records
- Should not happen due to UNIQUE constraint
- If seen, check for clock skew or manual insertions

## Integration Notes

### No New Memory Overhead
- No new in-memory maps or counters
- Uses existing `ip_table` data
- Minimal CPU impact (once per hour)

### Non-Invasive
- Existing `ipCountMap` → `ip_table` flow unchanged
- Snapshot happens after all updates are written
- Errors don't affect main proxy operation

### Future Enhancements
- Aggregate hourly data into daily summaries for long-term trends
- Add origin-specific time series
- Implement data export to S3 for archival

