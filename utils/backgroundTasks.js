import { updateFirebaseWithNewRequests } from './updateFirebaseWithNewRequests.js';
import { transferFirebaseRequestsToFunded } from './transferFirebaseRequestsToFunded.js';
import { backgroundTasksInterval } from '../config.js';

// Shared state object
const state = {
  urlCountMap: {},
  isProcessing: false,
  updateCounter: 0
};

// Function to strip protocol from URL
function stripProtocol(url) {
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

// Function to process all background tasks
async function processBackgroundTasks() {
  if (state.isProcessing) {
    console.log('Previous background task still processing, skipping...');
    return;
  }

  try {
    state.isProcessing = true;
    
    // Create a copy of the current urlCountMap
    const currentUrlCountMap = { ...state.urlCountMap };
    
    // Clear the original map
    state.urlCountMap = {};
    
    // Process Firebase update
    await updateFirebaseWithNewRequests(currentUrlCountMap);
    
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
  startBackgroundTasks,
  state
}; 