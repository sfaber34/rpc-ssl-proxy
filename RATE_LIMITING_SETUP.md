# Quick Setup Guide: Rate Limiting

## What Was Implemented

✅ Hourly rate limiting per IP address  
✅ High-performance design (no Firestore read per request)  
✅ Proper JSON-RPC 429 error responses  
✅ Uses existing `requestsLastHour` field from Firestore  
✅ Handles batch requests correctly  

## How to Enable

1. Add to your `.env` file:
   ```env
   MAX_HOURLY_REQUESTS=1000
   ```
   *(Adjust the number based on your needs)*

   **Optional tuning parameters:**
   ```env
   RATE_LIMIT_SYNC_INTERVAL=60000    # Sync every 60 seconds (default)
   RATE_LIMIT_CACHE_EXPIRY=3600000   # Cache expires after 1 hour (default)
   ```

2. Restart your proxy:
   ```bash
   pm2 restart proxy
   ```

3. Check the logs to confirm it's working:
   ```bash
   pm2 logs proxy
   ```
   
   You should see:
   ```
   🚦 Rate limiting enabled: 1000 requests per hour per IP
   ```

## That's It!

The rate limiting is now active. Users who exceed the limit will receive (with HTTP 200 status):

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": 429,
    "message": "This ip has exceeded the hourly request limit of 1000."
  }
}
```

**Note:** Returns HTTP 200 (JSON-RPC convention) with error details in the response body.

## Performance Notes

- ✅ **No slowdown**: Uses in-memory cache (no database read per request)
- ✅ **Background sync**: Syncs with Firestore every 60 seconds
- ⚠️ **Slight over-limit**: Users may get a few extra requests (within 60s window)
  - This is intentional and acceptable as you mentioned

## Files Changed

- **New**: `utils/rateLimiter.js` - Rate limiting logic
- **Modified**: `proxy.js` - Integration with rate limiter
- **Created**: `RATE_LIMITING.md` - Detailed documentation

---

For more details, see `RATE_LIMITING.md`

