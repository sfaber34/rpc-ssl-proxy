# Origin Filtering

## What It Does

Automatically filters out local/test origins so they don't get tracked in the database as real domains.

## What Gets Filtered

- **Private IPs**: `192.168.x.x`, `10.x.x.x`, `127.0.0.1`
- **IPs with ports**: `192.168.0.7:3000`
- **Localhost**: `localhost`
- **Browser extensions**: `chrome-extension://...`
- **Local TLDs**: `.local`, `.internal`, `.lan`, `.home`, `.localhost`
- **Invalid formats**: No TLD, IPv6 localhost, file:// protocol

## What Gets Tracked

- Real public domains: `example.com`, `speedrunethereum.com`, etc.
- Testing TLDs (allowed): `.test`, `.example`, `.invalid`

## How It Works

Filtering happens automatically at database write time using hybrid validation:
1. Fast blacklist check (extensions, localhost, ports)
2. IP address detection (all private ranges)
3. Local TLD check
4. DNS structure validation

## Testing

```bash
# Test the filtering logic
node database_scripts/testOriginValidator.js

# View what's being filtered (after proxy runs)
node database_scripts/viewOriginFilterStats.js
```

## Safety

- Bulletproof error handling (never breaks proxy)
- Performance optimized (<1ms per IP)
- Fails safe (filters uncertain origins)
- Logs filtered origins for monitoring

## Files

- `utils/originValidator.js` - Filtering logic
- `utils/updateRDSWithIpRequests.js` - Integration point  
- `database_scripts/testOriginValidator.js` - Test script
- `database_scripts/viewOriginFilterStats.js` - Stats viewer
