import { updateFirebaseWithNewRequests } from './updateFirebaseWithNewRequests.js';
import { updateFirebaseWithIpRequests } from './updateFirebaseWithIpRequests.js';
import { transferFirebaseRequestsToFunded } from './transferFirebaseRequestsToFunded.js';
import { backgroundTasksInterval } from '../config.js';

// Shared state object
const state = {
  urlCountMap: {},
  ipCountMap: {},
  isProcessing: false,
  updateCounter: 0
};

// Function to strip protocol from URL
function stripProtocol(url) {
  if (!url) return '';
  // Ensure url is a string
  if (typeof url !== 'string') {
    console.warn(`stripProtocol received non-string: ${typeof url}`);
    return '';
  }
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Function to safely update the urlCountMap
function updateUrlCountMap(origin, count = 1) {
  try {
    if (!origin) return;
    
    // Strip protocol from origin
    const cleanOrigin = stripProtocol(origin);
    
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
      // Clean the origin (strip protocol and trailing slash)
      const cleanOrigin = stripProtocol(origin);
      
      // Skip empty origins (from stripProtocol errors)
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
    
    // Process Firebase updates in parallel
    await Promise.all([
      updateFirebaseWithNewRequests(currentUrlCountMap),
      updateFirebaseWithIpRequests(currentIpCountMap)
    ]);
    
    // Increment counter
    state.updateCounter++;
    
    // Every 10th update, process transfers
    if (state.updateCounter >= 10) {
      console.log('Running transfers after Firebase update...');
      await transferFirebaseRequestsToFunded();
      state.updateCounter = 0;
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