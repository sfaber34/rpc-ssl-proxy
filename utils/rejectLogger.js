/**
 * Reject Logger - Async, non-blocking logging for rejected requests
 * 
 * Design principles:
 * - Fire-and-forget: logging never blocks the request flow
 * - Bulletproof: errors in logging cannot affect the main service
 * - Efficient: uses buffered writes to minimize I/O operations
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log file path - in project root
const LOG_FILE = path.join(__dirname, '..', 'requestReject.log');

// Write buffer and flush interval
let writeBuffer = [];
let flushScheduled = false;
const FLUSH_INTERVAL_MS = 1000; // Flush every second if there are pending writes
const MAX_BUFFER_SIZE = 100;    // Flush immediately if buffer gets this big

/**
 * Normalize IPv4-mapped IPv6 addresses
 */
function normalizeIP(ip) {
  try {
    if (!ip || typeof ip !== 'string') return 'unknown';
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  } catch {
    return 'unknown';
  }
}

/**
 * Safely extract client IP from request
 *
 * Must stay in sync with getClientIP in proxy.js: if the log records a different
 * identity than the rate limiter enforces on, rejected-request triage is misleading.
 * Forwarding headers are ignored for the reasons documented there.
 */
function getClientIP(req) {
  try {
    return normalizeIP(req?.ip || req?.socket?.remoteAddress || 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * Safely extract origin from request
 */
function getOrigin(req) {
  try {
    return req?.headers?.origin || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Safely stringify request body for logging
 */
function safeStringifyRequest(body) {
  try {
    const str = JSON.stringify(body);
    // Truncate very long requests to prevent log bloat
    if (str.length > 1000) {
      return str.substring(0, 1000) + '...[truncated]';
    }
    return str;
  } catch {
    return '[unable to stringify]';
  }
}

/**
 * Flush the write buffer to disk
 * This is called asynchronously and errors are silently caught
 */
function flushBuffer() {
  // Grab current buffer and reset
  const toWrite = writeBuffer;
  writeBuffer = [];
  flushScheduled = false;
  
  if (toWrite.length === 0) return;
  
  // Join all entries and write in one operation
  const content = toWrite.join('');
  
  // Fire-and-forget write with error handling
  fs.appendFile(LOG_FILE, content, (err) => {
    if (err) {
      // Log to console but don't throw - logging must never break the service
      console.error('[RejectLogger] Failed to write to log file:', err.message);
    }
  });
}

/**
 * Schedule a buffer flush if not already scheduled
 */
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  
  // Use setImmediate for non-blocking scheduling
  setImmediate(() => {
    setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
  });
}

/**
 * Log a rejected request - FIRE AND FORGET
 * This function returns immediately and never throws
 * 
 * @param {object} req - Express request object
 * @param {string} reason - Reason for rejection
 */
function logRejectedRequest(req, reason) {
  try {
    const timestamp = new Date().toISOString();
    const ip = getClientIP(req);
    const origin = getOrigin(req);
    const requestStr = safeStringifyRequest(req?.body);
    
    // Format: timestamp | ip | origin | reason | request
    const logEntry = `${timestamp} | ${ip} | ${origin} | ${reason} | ${requestStr}\n`;
    
    // Add to buffer
    writeBuffer.push(logEntry);
    
    // Flush immediately if buffer is large, otherwise schedule
    if (writeBuffer.length >= MAX_BUFFER_SIZE) {
      setImmediate(flushBuffer);
    } else {
      scheduleFlush();
    }
  } catch (err) {
    // Absolute last resort - log to console but NEVER throw
    try {
      console.error('[RejectLogger] Error in logRejectedRequest:', err?.message || 'unknown error');
    } catch {
      // Even console.error failed - give up silently
    }
  }
}

/**
 * Force flush any pending log entries (useful for graceful shutdown)
 */
function forceFlush() {
  try {
    flushBuffer();
  } catch {
    // Silently ignore
  }
}

export { logRejectedRequest, forceFlush };
