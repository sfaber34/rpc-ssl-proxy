/**
 * Origin Validator Utility
 * 
 * Filters out local/test origins from being tracked in the database.
 * Uses hybrid validation: blacklist known bad patterns + DNS structure validation.
 * 
 * Design principles:
 * - MUST NOT throw errors (bulletproof error handling)
 * - Performance-optimized (fast checks first)
 * - Tracks filtered origins for monitoring
 * - Fails safe (treats uncertain origins as local)
 */

// Statistics tracking for monitoring
const stats = {
  totalChecks: 0,
  filteredCount: 0,
  errorCount: 0,
  filteredOrigins: {}, // { origin: count }
  lastReset: Date.now()
};

/**
 * Check if an origin is a local/test origin (should be filtered out)
 * 
 * Returns true if origin should be FILTERED (is local)
 * Returns false if origin is a real public domain
 * 
 * @param {string} origin - The origin to validate
 * @returns {boolean} - true if local (filter it), false if real domain (keep it)
 */
function isLocalOrigin(origin) {
  try {
    stats.totalChecks++;
    
    // Validate input
    if (!origin || typeof origin !== 'string') {
      return true; // Filter out invalid input
    }
    
    const normalized = origin.toLowerCase().trim();
    
    // Empty or too short
    if (normalized.length === 0 || normalized.length > 253) {
      return true; // DNS max length is 253 characters
    }
    
    // === STEP 1: Definite rejections (fast path) ===
    // These are definitely local/invalid origins
    
    // Browser extensions
    if (normalized.includes('extension://')) {
      return true;
    }
    
    // File protocol
    if (normalized.startsWith('file://')) {
      return true;
    }
    
    // Contains port number (origins shouldn't have ports)
    if (normalized.includes(':')) {
      return true;
    }
    
    // Localhost variants
    if (normalized === 'localhost' || normalized.startsWith('localhost.')) {
      return true;
    }
    
    // === STEP 2: IP address detection (regex-based) ===
    
    // IPv4 addresses (including private ranges)
    const ipv4Patterns = [
      /^127\./,                                    // Localhost (127.0.0.1)
      /^192\.168\./,                              // Private network
      /^10\./,                                    // Private network
      /^172\.(1[6-9]|2\d|3[01])\./,              // Private network (172.16-31)
      /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/     // Any IPv4 address
    ];
    
    for (const pattern of ipv4Patterns) {
      if (pattern.test(normalized)) {
        return true;
      }
    }
    
    // IPv6 addresses (simplified detection)
    if (normalized.includes('[::') || normalized === '::1' || normalized.startsWith('::1')) {
      return true;
    }
    
    // === STEP 3: Local TLDs ===
    // These TLDs are reserved for local use only
    
    const localTLDs = [
      '.local',     // mDNS (multicast DNS)
      '.internal',  // Common for internal services
      '.lan',       // Local Area Network
      '.home',      // Home networks
      '.localhost'  // RFC 6761 - reserved for localhost
    ];
    
    for (const tld of localTLDs) {
      if (normalized.endsWith(tld)) {
        return true;
      }
    }
    
    // === STEP 4: DNS Structure Validation ===
    // Real domains must follow DNS naming conventions
    
    // Must contain at least one dot (domain.tld)
    if (!normalized.includes('.')) {
      return true;
    }
    
    // Split into parts and validate
    const parts = normalized.split('.');
    
    // Must have at least 2 parts (domain + TLD)
    if (parts.length < 2) {
      return true;
    }
    
    // Check if all parts are numeric (it's an IP address)
    const allNumeric = parts.every(part => /^\d+$/.test(part));
    if (allNumeric) {
      return true; // It's an IP address
    }
    
    // === STEP 5: TLD Validation ===
    // The last segment (TLD) must be valid
    
    const tld = parts[parts.length - 1];
    
    // TLD must be at least 2 characters and only letters
    if (tld.length < 2 || !/^[a-z]+$/.test(tld)) {
      return true;
    }
    
    // === STEP 6: DNS Segment Validation ===
    // Each segment must follow DNS naming rules
    
    for (const segment of parts) {
      // Segment cannot be empty
      if (segment.length === 0) {
        return true;
      }
      
      // Segment max length is 63 characters (DNS standard)
      if (segment.length > 63) {
        return true;
      }
      
      // Segment must contain only alphanumeric and hyphens
      // Cannot start or end with hyphen
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(segment)) {
        return true;
      }
    }
    
    // === Passed all validation ===
    // This appears to be a valid public domain
    return false;
    
  } catch (error) {
    // CRITICAL: Never throw errors - fail safe by filtering
    console.error('⚠️  Error validating origin (treating as local):', {
      origin: origin,
      error: error.message
    });
    stats.errorCount++;
    return true; // When in doubt, filter it out
  }
}

/**
 * Filter origins object, removing local/test origins
 * 
 * @param {Object} origins - Object with origin keys and request count values
 * @returns {Object} - Filtered origins object
 */
function filterOrigins(origins) {
  try {
    // Handle invalid input
    if (!origins || typeof origins !== 'object') {
      return {};
    }
    
    const filtered = {};
    const blocked = {};
    
    for (const [origin, count] of Object.entries(origins)) {
      try {
        if (isLocalOrigin(origin)) {
          // Track what we filtered
          blocked[origin] = count;
          stats.filteredCount++;
          
          // Update filtered origins stats
          if (!stats.filteredOrigins[origin]) {
            stats.filteredOrigins[origin] = 0;
          }
          stats.filteredOrigins[origin] += count;
        } else {
          // Keep real domains
          filtered[origin] = count;
        }
      } catch (error) {
        // If validation fails for one origin, log and continue with others
        console.error('⚠️  Error filtering origin (excluding):', {
          origin: origin,
          error: error.message
        });
        // When in doubt, exclude it
        blocked[origin] = count;
      }
    }
    
    // Log filtered origins if any were blocked
    if (Object.keys(blocked).length > 0) {
      console.log('🔒 Filtered local origins:', blocked);
    }
    
    return filtered;
    
  } catch (error) {
    // CRITICAL: If entire filtering fails, return empty object
    // This prevents local origins from being tracked
    console.error('❌ Critical error in filterOrigins (returning empty):', error);
    stats.errorCount++;
    return {};
  }
}

/**
 * Get validation statistics (for monitoring)
 * 
 * @returns {Object} - Statistics object
 */
function getStats() {
  try {
    return {
      ...stats,
      uptime: Date.now() - stats.lastReset,
      filterRate: stats.totalChecks > 0 
        ? ((stats.filteredCount / stats.totalChecks) * 100).toFixed(2) + '%'
        : '0%'
    };
  } catch (error) {
    console.error('⚠️  Error getting stats:', error);
    return { error: error.message };
  }
}

/**
 * Reset statistics (for testing or periodic cleanup)
 */
function resetStats() {
  try {
    stats.totalChecks = 0;
    stats.filteredCount = 0;
    stats.errorCount = 0;
    stats.filteredOrigins = {};
    stats.lastReset = Date.now();
  } catch (error) {
    console.error('⚠️  Error resetting stats:', error);
  }
}

/**
 * Test function to validate the filtering logic
 * 
 * @param {string} origin - Origin to test
 * @returns {Object} - Test result with details
 */
function testOrigin(origin) {
  try {
    const isLocal = isLocalOrigin(origin);
    return {
      origin: origin,
      isLocal: isLocal,
      shouldFilter: isLocal,
      willTrack: !isLocal,
      verdict: isLocal ? '❌ FILTERED (local/test)' : '✅ TRACKED (real domain)'
    };
  } catch (error) {
    return {
      origin: origin,
      error: error.message,
      verdict: '❌ ERROR (filtered for safety)'
    };
  }
}

export {
  isLocalOrigin,
  filterOrigins,
  getStats,
  resetStats,
  testOrigin
};
