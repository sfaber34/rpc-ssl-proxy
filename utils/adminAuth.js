/**
 * Admin Authentication Middleware
 * 
 * Protects sensitive admin endpoints that expose IP addresses and other
 * security-relevant information. Uses API key authentication.
 * 
 * Setup:
 *   1. Add ADMIN_API_KEY to your .env file
 *   2. When calling protected endpoints, include header: X-Admin-Key: <your-key>
 * 
 * If ADMIN_API_KEY is not set, protected endpoints will be DISABLED (return 403)
 * to prevent accidental exposure.
 */

import dotenv from 'dotenv';
dotenv.config();

// Get API key from environment
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// Log warning if not configured
if (!ADMIN_API_KEY) {
  console.log('⚠️  ADMIN_API_KEY not set - admin endpoints (/ratelimitstatus, /blackliststatus) will be disabled');
} else {
  console.log('🔐 Admin API key configured - admin endpoints protected');
}

/**
 * Express middleware to require admin API key
 * 
 * Usage:
 *   app.get('/ratelimitstatus', requireAdminKey, (req, res) => { ... });
 * 
 * Client must send header:
 *   X-Admin-Key: <your-api-key>
 */
function requireAdminKey(req, res, next) {
  try {
    // If no API key is configured, disable endpoint entirely
    if (!ADMIN_API_KEY) {
      return res.status(403).json({
        error: 'Admin endpoints are disabled. Set ADMIN_API_KEY in environment.'
      });
    }
    
    // Get the API key from request header
    const providedKey = req.headers['x-admin-key'];
    
    // Check if key is provided
    if (!providedKey) {
      console.log(`🔒 Admin endpoint ${req.path} - no API key provided`);
      return res.status(401).json({
        error: 'Unauthorized. X-Admin-Key header required.'
      });
    }
    
    // Constant-time comparison to prevent timing attacks
    if (!secureCompare(providedKey, ADMIN_API_KEY)) {
      console.log(`🔒 Admin endpoint ${req.path} - invalid API key`);
      return res.status(403).json({
        error: 'Forbidden. Invalid API key.'
      });
    }
    
    // Key is valid, proceed
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - True if strings are equal
 */
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  // Ensure both strings have the same length for constant-time comparison
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Check if admin auth is configured
 * @returns {boolean}
 */
function isAdminAuthConfigured() {
  return !!ADMIN_API_KEY;
}

export {
  requireAdminKey,
  isAdminAuthConfigured
};
