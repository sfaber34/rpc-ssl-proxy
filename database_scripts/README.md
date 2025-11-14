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

### createIpTable.js

Creates the `ip_table` for tracking IP request statistics.

**Schema:**
- `ip` (VARCHAR(45), PRIMARY KEY) - IP address
- `requests_total` (BIGINT) - Total requests from this IP
- `requests_last_hour` (INTEGER) - Requests in the last hour
- `last_reset_timestamp` (BIGINT) - Unix timestamp of last hourly reset
- `origins` (JSONB) - Map of origin domains to request counts
- `updated_at` (TIMESTAMP) - Last update timestamp

**Usage:**
```bash
node database_scripts/createIpTable.js
```

⚠️ **Warning:** This will DROP the existing table if it exists. You will be prompted for confirmation.

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

