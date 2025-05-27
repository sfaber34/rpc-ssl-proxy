import { updateFirebaseWithNewRequests } from './updateFirebaseWithNewRequests.js';
import { batchTransferUsdcForRequests } from './batchTransferUsdcForRequests.js';
import { backgroundTasksInterval } from '../config.js';

// Shared state object
const state = {
  urlCountMap: {},
  isProcessing: false,
  updateCounter: 0
};

// Function to strip protocol from URL
function stripProtocol(url) {
  return url.replace(/^https?:\/\//, '');
}

// Function to safely update the urlCountMap
function updateUrlCountMap(referer) {
  try {
    if (!referer) return;
    
    // Strip protocol from referer
    const cleanReferer = stripProtocol(referer);
    
    if (!state.urlCountMap[cleanReferer]) {
      state.urlCountMap[cleanReferer] = 0;
    }
    state.urlCountMap[cleanReferer]++;
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
      await batchTransferUsdcForRequests();
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