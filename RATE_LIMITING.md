# Rate Limiting Configuration

## Overview

The RPC SSL Proxy now supports hourly rate limiting per IP address. This feature prevents individual IPs from exceeding a specified number of requests per hour.

## Configuration

Add the following to your `.env` file:

```env
MAX_HOURLY_REQUESTS=1000
RATE_LIMIT_SYNC_INTERVAL=60000
RATE_LIMIT_CACHE_EXPIRY=3600000
```

### Environment Variables

- **MAX_HOURLY_REQUESTS**
  - Maximum number of requests allowed per IP per hour
  - Default: `0` (rate limiting disabled)
  - Setting to 0 or leaving unset will disable rate limiting

- **RATE_LIMIT_SYNC_INTERVAL** *(optional)*
  - How often (in milliseconds) to sync the in-memory cache with Firestore
  - Default: `60000` (60 seconds)
  - Lower values = more accurate but more database reads
  - Higher values = better performance but less accurate

- **RATE_LIMIT_CACHE_EXPIRY** *(optional)*
  - How long (in milliseconds) to keep IPs in cache before cleaning them up
  - Default: `3600000` (1 hour)
  - Should typically match or exceed your rate limit window

## How It Works

The rate limiting system is designed for **high performance** and minimal impact on request latency:

1. **In-Memory Cache**: Request counts are maintained in an in-memory cache for instant lookup
2. **No Database Read Per Request**: The system does NOT query Firestore on every request
3. **Background Sync**: The cache syncs with Firestore's `requestsLastHour` field every 60 seconds
4. **Fast Rejection**: Rate-limited requests are rejected immediately before any processing

### Architecture

```
Request → Check In-Memory Cache → Rate Limited? → Return 429 Error
                                 ↓
                                 No → Process Request → Increment Cache
                                      
Background Task (every 60s) → Sync Cache ↔ Firestore
```

## Error Response

When an IP exceeds the hourly limit, they receive this JSON-RPC error response with **HTTP 200** status:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": 429,
    "message": "This ip has exceeded the hourly request limit of 1000."
  }
}
```

**Note:** The HTTP status is 200 (following JSON-RPC conventions), but the error code in the response body is 429.

## Performance Impact

- **Minimal**: Only an in-memory lookup is performed per request
- **No Database Calls**: Firestore is only accessed during background sync (every 60 seconds)
- **Acceptable Over-Limit**: Users may exceed the limit by a small margin (requests within the 60-second sync window)

## Implementation Details

### Key Files

- **`utils/rateLimiter.js`**: Core rate limiting logic
  - `checkRateLimit()`: Check if IP is within limits
  - `incrementRequestCount()`: Increment counter after successful request
  - `syncCacheWithFirestore()`: Background sync with Firestore
  - `generateRateLimitError()`: Generate JSON-RPC error response

- **`proxy.js`**: Integration point
  - Rate limit check at the start of POST requests
  - Counter increment after successful responses
  - Rate limit sync started on server initialization

### Firestore Integration

The system uses the existing `requestsLastHour` field in the Firestore `ips` collection:

- **Collection**: `process.env.FIREBASE_COLLECTION_IPS` (default: 'ips')
- **Field**: `requestsLastHour` - Updated by existing background tasks
- **Reset**: Automatically reset every hour by the lazy reset mechanism

### Cache Behavior

- **Sync Interval**: 60 seconds
- **Cache Expiry**: 1 hour (stale entries are cleaned up)
- **Local Priority**: Recent local increments are preserved during sync
- **Firestore as Source of Truth**: Older cache entries are replaced with Firestore values

## Testing

To test the rate limiting:

1. Set a low limit in `.env`:
   ```env
   MAX_HOURLY_REQUESTS=10
   ```

2. Restart the proxy:
   ```bash
   pm2 restart proxy
   ```

3. Send requests until you hit the limit:
   ```bash
   for i in {1..15}; do
     curl -X POST https://your-proxy.com/ \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   done
   ```

4. After ~10 requests, you should receive the 429 error response

## Monitoring

Check the logs for rate limiting activity:

```bash
pm2 logs proxy
```

You'll see messages like:
- `🚦 Rate limiting enabled: 1000 requests per hour per IP`
- `🔄 Syncing rate limit cache with Firestore...`
- `✅ Rate limit cache synced: 25 IPs updated, 2 stale entries cleaned`
- `🚫 Rate limit exceeded for IP 1.2.3.4: 1001/1000 requests`

## Disabling Rate Limiting

To disable rate limiting, either:

1. Remove `MAX_HOURLY_REQUESTS` from `.env`, or
2. Set it to 0:
   ```env
   MAX_HOURLY_REQUESTS=0
   ```

The system will log: `⚠️  MAX_HOURLY_REQUESTS not set or is 0 - rate limiting disabled`

## Notes

- Rate limiting only applies to POST requests (the main RPC endpoint)
- GET requests, status endpoints, and other routes are not rate limited
- Batch requests count as multiple requests (1 per item in the batch)
- Requests to fallback URLs are NOT counted (consistent with existing behavior)
- Failed requests are NOT counted
- The system gracefully handles IP extraction failures

