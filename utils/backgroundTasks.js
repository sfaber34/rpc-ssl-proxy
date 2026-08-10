import { updateFirebaseWithNewRequests } from './updateFirebaseWithNewRequests.js';
import { updateRDSWithIpRequests } from './updateRDSWithIpRequests.js';
import { transferFirebaseRequestsToFunded } from './transferFirebaseRequestsToFunded.js';
import { normalizeOrigin } from './originValidator.js';
import { backgroundTasksInterval, firebaseUpdatesEnabled } from '../config.js';

// Shared state object
const state = {
  urlCountMap: {},
  ipCountMap: {},
  isProcessing: false,
  updateCounter: 0
};

// Function to safely update the urlCountMap
function updateUrlCountMap(origin, count = 1) {
  try {
    if (!origin) return;
    
    // Canonical key shared with rate limit enforcement (see originValidator.normalizeOrigin)
    const cleanOrigin = normalizeOrigin(origin);
    
    // Skip localhost URLs (localhost:3000, localhost:3001, etc.)
    if (cleanOrigin.includes('localhost')) {
      console.log(`Skipping localhost URL: ${cleanOrigin}`);
      return;
    }
    
    // Skip buidlguidl-client origin
    if (cleanOrigin === 'buidlguidl-client') {
      console.log(`Skipping buidlguidl-client origin: ${cleanOrigin}`);
      return;
    }
    
    if (!state.urlCountMap[cleanOrigin]) {
      state.urlCountMap[cleanOrigin] = 0;
    }
    state.urlCountMap[cleanOrigin] += count;
    
    if (count > 1) {
      console.log(`Added ${count} requests for ${cleanOrigin} (batch request)`);
    }
  } catch (error) {
    console.error('Error updating urlCountMap:', error);
  }
}

// Function to safely update the ipCountMap
function updateIpCountMap(ip, origin, count = 1) {
  try {
    if (!ip || ip === 'unknown') return;
    
    // Ensure ip is a string
    if (typeof ip !== 'string') {
      console.warn(`updateIpCountMap received non-string IP: ${typeof ip}`);
      return;
    }
    
    // Skip localhost IPs
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('localhost')) {
      console.log(`Skipping localhost IP: ${ip}`);
      return;
    }
    
    // Skip IPs from buidlguidl-client origin
    // Must stay in sync with EXEMPT_ORIGINS in utils/rateLimiter.js
    if (origin) {
      const cleanOrigin = normalizeOrigin(origin);
      if (cleanOrigin === 'buidlguidl-client') {
        console.log(`Skipping IP tracking for buidlguidl-client origin: ${ip}`);
        return;
      }
    }
    
    // Initialize IP entry if it doesn't exist
    if (!state.ipCountMap[ip]) {
      state.ipCountMap[ip] = {
        count: 0,
        origins: {}
      };
    }
    
    // Update total count for this IP
    state.ipCountMap[ip].count += count;
    
    // Update origin count for this IP
    if (origin && origin !== 'unknown') {
      // Canonical key shared with rate limit enforcement (see originValidator.normalizeOrigin)
      const cleanOrigin = normalizeOrigin(origin);
      
      // Skip empty origins (from normalizeOrigin errors)
      if (!cleanOrigin) {
        return;
      }
      
      // Skip localhost origins
      if (cleanOrigin.includes('localhost')) {
        console.log(`Skipping localhost origin: ${cleanOrigin}`);
        return;
      }
      
      if (!state.ipCountMap[ip].origins[cleanOrigin]) {
        state.ipCountMap[ip].origins[cleanOrigin] = 0;
      }
      state.ipCountMap[ip].origins[cleanOrigin] += count;
    }
    
    if (count > 1) {
      console.log(`Added ${count} requests for IP ${ip} from origin ${origin} (batch request)`);
    }
  } catch (error) {
    console.error('Error updating ipCountMap:', error);
  }
}

// Merge counts back into the live maps so a failed write is retried next cycle.
// Only ever called for the map whose own write failed: the RDS write is additive
// (requests_last_hour = requests_last_hour + EXCLUDED...), so restoring counts it
// already committed re-sends them and compounds every counter it feeds.
function restoreUrlCounts(urlCounts) {
  for (const url in urlCounts) {
    state.urlCountMap[url] = (state.urlCountMap[url] || 0) + urlCounts[url];
  }
}

function restoreIpCounts(ipCounts) {
  for (const ip in ipCounts) {
    if (!state.ipCountMap[ip]) {
      state.ipCountMap[ip] = ipCounts[ip];
      continue;
    }
    state.ipCountMap[ip].count += ipCounts[ip].count;
    for (const origin in ipCounts[ip].origins) {
      state.ipCountMap[ip].origins[origin] =
        (state.ipCountMap[ip].origins[origin] || 0) + ipCounts[ip].origins[origin];
    }
  }
}

// Function to process all background tasks
async function processBackgroundTasks() {
  if (state.isProcessing) {
    console.log('Previous background task still processing, skipping...');
    return;
  }

  try {
    state.isProcessing = true;
    
    // Create a copy of the current urlCountMap and ipCountMap
    const currentUrlCountMap = { ...state.urlCountMap };
    const currentIpCountMap = { ...state.ipCountMap };
    
    // Clear the original maps
    state.urlCountMap = {};
    state.ipCountMap = {};
    
    // RDS carries IP counts for rate limiting, Firebase carries the donation ledger.
    // Settle them independently so a failure in one never restores the other's data.
    const [ipWrite, ledgerWrite] = await Promise.allSettled([
      updateRDSWithIpRequests(currentIpCountMap),
      firebaseUpdatesEnabled
        ? updateFirebaseWithNewRequests(currentUrlCountMap)
        : Promise.resolve()
    ]);

    if (ipWrite.status === 'rejected') {
      console.error('❌ RDS update failed, restoring IP counts to retry next cycle:', ipWrite.reason);
      restoreIpCounts(currentIpCountMap);
    }

    if (ledgerWrite.status === 'rejected') {
      console.error('❌ Firebase update failed, restoring URL counts to retry next cycle:', ledgerWrite.reason);
      restoreUrlCounts(currentUrlCountMap);
    }

    if (ipWrite.status === 'rejected' || ledgerWrite.status === 'rejected') {
      console.log('📦 Failed data restored. Will retry in next background task cycle.');
      return;
    }

    state.updateCounter++;

    // Every 10th update, process transfers. Counter resets before the attempt so a
    // failing transfer retries on the normal cadence instead of every cycle, and
    // cannot reach the restore paths above.
    if (firebaseUpdatesEnabled && state.updateCounter >= 10) {
      state.updateCounter = 0;
      console.log('Running transfers after Firebase update...');
      try {
        await transferFirebaseRequestsToFunded();
      } catch (transferError) {
        console.error('⚠️  Firebase transfer failed (non-fatal, no counts affected):', transferError);
      }
    }
  } catch (error) {
    console.error('Error in background tasks:', error);
  } finally {
    state.isProcessing = false;
  }
}

// Start the background tasks
function startBackgroundTasks() {
  setInterval(() => {
    try {
      processBackgroundTasks();
    } catch (error) {
      console.error('Critical error in background task interval:', error);
      state.isProcessing = false;
    }
  }, backgroundTasksInterval * 1000);
}

export {
  updateUrlCountMap,
  updateIpCountMap,
  startBackgroundTasks,
  state
}; 