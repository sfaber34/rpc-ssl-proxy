import { db } from './firebaseClient.js';
import { getRequestsOutstandingFromFirebase } from './getRequestsOutstandingFromFirebase.js';
import { clearRequestsOutstandingFromFirebase } from './clearRequestsOutstandingFromFirebase.js';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function transferFirebaseRequestsToFunded() {
  try {
    // Get the urlList document to work with current data
    const urlListRef = db.collection(firebaseCollection).doc('urlList');
    const urlListSnap = await urlListRef.get();
    
    if (!urlListSnap.exists) {
      console.log("No urlList document found");
      return;
    }

    let urlListData = urlListSnap.data();
    let totalCovered = 0;
    let hasChanges = false;

    for (const [url, urlData] of Object.entries(urlListData)) {
      if (urlData && typeof urlData === 'object') {
        const outstanding = urlData.requestsOutstanding || 0;
        const remaining = urlData.requestsRemaining || 0;

        if (outstanding > 0 && remaining > 0) {
          hasChanges = true;
          
          if (remaining >= outstanding) {
            // Enough funded requests to cover all outstanding
            const covered = outstanding;
            urlListData[url].requestsRemaining = remaining - outstanding;
            urlListData[url].requestsOutstanding = 0;
            totalCovered += covered;
            console.log(`${url}: Covered all ${covered} outstanding requests. Remaining: ${remaining - outstanding}, Outstanding: 0`);
          } else {
            // Not enough funded requests to cover all outstanding
            const covered = remaining;
            urlListData[url].requestsRemaining = 0;
            urlListData[url].requestsOutstanding = outstanding - remaining;
            totalCovered += covered;
            console.log(`${url}: Covered ${covered} outstanding requests. Remaining: 0, Outstanding: ${outstanding - remaining}`);
          }
        }
      }
    }

    if (hasChanges && totalCovered > 0) {
      // Update urlList document
      await urlListRef.set(urlListData);
      
      // Update totalFundedRequests in requestCount document
      const requestCountRef = db.collection(firebaseCollection).doc('requestCount');
      const requestCountSnap = await requestCountRef.get();
      let requestCountData = requestCountSnap.exists ? requestCountSnap.data() : {};
      
      requestCountData.totalFundedRequests = (requestCountData.totalFundedRequests || 0) + totalCovered;
      await requestCountRef.set(requestCountData);
      
      console.log(`Transfer completed. Total outstanding requests covered: ${totalCovered}`);
      console.log(`Updated totalFundedRequests to: ${requestCountData.totalFundedRequests}`);
    } else {
      console.log("No transfers needed - no URLs with both outstanding and remaining requests.");
    }

  } catch (error) {
    console.error("Error in transferFirebaseRequestsToFunded:", error);
    throw error;
  }
}

export { transferFirebaseRequestsToFunded };