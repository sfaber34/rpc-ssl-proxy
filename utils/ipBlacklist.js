/**
 * IP Blacklist Module
 * 
 * Reads IPs from a file and blocks all requests from those IPs.
 * The blacklist file is watched for changes and hot-reloaded automatically.
 * 
 * Blacklist file format:
 * - One IP per line
 * - Lines starting with # are comments
 * - Empty lines are ignored
 * - Supports both IPv4 and IPv6 addresses
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default blacklist file location (in project root)
const DEFAULT_BLACKLIST_PATH = path.join(__dirname, '..', 'ip_blacklist.txt');

// In-memory blacklist set for fast lookups
let blacklistedIPs = new Set();

// Track if we've started watching the file
let watcherStarted = false;
let lastLoadTime = null;

/**
 * Parse the blacklist file contents and return a Set of IPs
 * @param {string} content - File contents
 * @returns {Set<string>} - Set of blacklisted IPs
 */
function parseBlacklistContent(content) {
  const ips = new Set();
  
  if (!content) return ips;
  
  const lines = content.split('\n');
  
  for (const line of lines) {
    // Trim whitespace
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Handle inline comments (e.g., "1.2.3.4 # some comment")
    const ipPart = trimmed.split('#')[0].trim();
    
    if (ipPart) {
      // Normalize the IP (handle IPv4-mapped IPv6 addresses)
      const normalizedIP = normalizeBlacklistIP(ipPart);
      ips.add(normalizedIP);
    }
  }
  
  return ips;
}

/**
 * Normalize IP address for consistent comparison
 * @param {string} ip - IP address
 * @returns {string} - Normalized IP
 */
function normalizeBlacklistIP(ip) {
  if (!ip) return '';
  
  // Strip IPv4-mapped IPv6 prefix (::ffff:)
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  
  return ip.toLowerCase();
}

/**
 * Load the blacklist from file
 * @param {string} filePath - Path to blacklist file
 * @returns {boolean} - True if loaded successfully
 */
function loadBlacklist(filePath = DEFAULT_BLACKLIST_PATH) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`📋 IP blacklist file not found at ${filePath} - no IPs blacklisted`);
      blacklistedIPs = new Set();
      return true;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const newBlacklist = parseBlacklistContent(content);
    
    // Log changes
    const added = [...newBlacklist].filter(ip => !blacklistedIPs.has(ip));
    const removed = [...blacklistedIPs].filter(ip => !newBlacklist.has(ip));
    
    blacklistedIPs = newBlacklist;
    lastLoadTime = new Date();
    
    if (blacklistedIPs.size > 0) {
      console.log(`🚫 IP blacklist loaded: ${blacklistedIPs.size} IP(s) blacklisted`);
      if (added.length > 0 && removed.length === 0 && added.length === blacklistedIPs.size) {
        // Initial load - show all IPs
        console.log(`   Blacklisted: ${[...blacklistedIPs].join(', ')}`);
      } else {
        // Update - show changes
        if (added.length > 0) {
          console.log(`   Added: ${added.join(', ')}`);
        }
        if (removed.length > 0) {
          console.log(`   Removed: ${removed.join(', ')}`);
        }
      }
    } else {
      console.log(`📋 IP blacklist loaded: empty (no IPs blacklisted)`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to load IP blacklist from ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Start watching the blacklist file for changes
 * @param {string} filePath - Path to blacklist file
 */
function startWatchingBlacklist(filePath = DEFAULT_BLACKLIST_PATH) {
  if (watcherStarted) {
    return;
  }
  
  // Initial load
  loadBlacklist(filePath);
  
  // Watch for file changes
  try {
    // Use polling for better cross-platform compatibility
    const checkInterval = 5000; // Check every 5 seconds
    let lastMtime = null;
    
    setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) {
          if (blacklistedIPs.size > 0) {
            console.log(`📋 IP blacklist file removed - clearing blacklist`);
            blacklistedIPs = new Set();
          }
          lastMtime = null;
          return;
        }
        
        const stats = fs.statSync(filePath);
        const currentMtime = stats.mtimeMs;
        
        if (lastMtime !== null && currentMtime !== lastMtime) {
          console.log(`🔄 IP blacklist file changed - reloading...`);
          loadBlacklist(filePath);
        }
        
        lastMtime = currentMtime;
      } catch (err) {
        // Ignore errors during polling (file might be temporarily unavailable)
      }
    }, checkInterval);
    
    watcherStarted = true;
    console.log(`👁️  Watching IP blacklist file for changes: ${filePath}`);
  } catch (error) {
    console.error(`⚠️  Could not watch blacklist file:`, error.message);
  }
}

/**
 * Check if an IP is blacklisted
 * 
 * CRITICAL: This function is called on every request and MUST:
 * - Be fast (O(1) Set lookup)
 * - Never throw errors
 * - Default to NOT blacklisted if anything goes wrong (fail open)
 * 
 * @param {string} ip - The client IP address
 * @returns {boolean} - True if IP is blacklisted
 */
function isIPBlacklisted(ip) {
  try {
    if (!ip || ip === 'unknown') {
      return false;
    }
    
    const normalizedIP = normalizeBlacklistIP(ip);
    return blacklistedIPs.has(normalizedIP);
  } catch (error) {
    // CRITICAL: Never let blacklist errors block legitimate traffic
    console.error('⚠️  IP blacklist check error (allowing request):', error.message);
    return false;
  }
}

/**
 * Get blacklist status (for monitoring endpoints)
 */
function getBlacklistStatus() {
  return {
    blacklistedCount: blacklistedIPs.size,
    blacklistedIPs: [...blacklistedIPs],
    lastLoadTime: lastLoadTime?.toISOString() || null,
    isWatching: watcherStarted
  };
}

/**
 * Manually add an IP to the blacklist (runtime only, not persisted)
 * @param {string} ip - IP to blacklist
 */
function addToBlacklist(ip) {
  const normalizedIP = normalizeBlacklistIP(ip);
  if (normalizedIP && !blacklistedIPs.has(normalizedIP)) {
    blacklistedIPs.add(normalizedIP);
    console.log(`🚫 IP ${normalizedIP} added to blacklist (runtime only)`);
    return true;
  }
  return false;
}

/**
 * Manually remove an IP from the blacklist (runtime only)
 * @param {string} ip - IP to remove
 */
function removeFromBlacklist(ip) {
  const normalizedIP = normalizeBlacklistIP(ip);
  if (blacklistedIPs.has(normalizedIP)) {
    blacklistedIPs.delete(normalizedIP);
    console.log(`✅ IP ${normalizedIP} removed from blacklist (runtime only)`);
    return true;
  }
  return false;
}

export {
  isIPBlacklisted,
  loadBlacklist,
  startWatchingBlacklist,
  getBlacklistStatus,
  addToBlacklist,
  removeFromBlacklist,
  DEFAULT_BLACKLIST_PATH
};
