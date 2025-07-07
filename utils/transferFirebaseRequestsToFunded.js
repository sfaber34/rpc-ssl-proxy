import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getRequestsOutstandingFromFirebase } from './getRequestsOutstandingFromFirebase.js';
import { clearRequestsOutstandingFromFirebase } from './clearRequestsOutstandingFromFirebase.js';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function transferFirebaseRequestsToFunded() {
  try {
    const requestsOutstanding = await getRequestsOutstandingFromFirebase();
    console.log("Requests outstanding:", requestsOutstanding);

    // Get the urlList document
    const urlListRef = doc(db, firebaseCollection, 'urlList');
    const urlListSnap = await getDoc(urlListRef);
    let urlListData = urlListSnap.exists() ? urlListSnap.data() : {};

    // Get the requestCount document for totalFundedRequests
    const requestCountRef = doc(db, firebaseCollection, 'requestCount');
    const requestCountSnap = await getDoc(requestCountRef);
    let requestCountData = requestCountSnap.exists() ? requestCountSnap.data() : { totalFundedRequests: 0 };

    let totalNewlyFunded = 0;

    // Process each URL's outstanding requests
    for (const [url, data] of Object.entries(requestsOutstanding)) {
      if (typeof data.requestsOutstanding === 'number' && data.requestsOutstanding > 0) {
        // Get the current state of the URL
        const currentData = urlListData[url] || {
          requestsRemaining: 0,
          requestsOutstanding: 0,
          requestsTotal: 0
        };

        // Calculate how many requests we can actually fund
        const requestsToFund = Math.min(
          currentData.requestsRemaining || 0,
          data.requestsOutstanding
        );

        // Update the URL's data, preserving requestsTotal
        urlListData[url] = {
          requestsRemaining: Math.max(0, (currentData.requestsRemaining || 0) - requestsToFund),
          // If we couldn't fund all outstanding requests, keep the remainder
          requestsOutstanding: data.requestsOutstanding - requestsToFund,
          // Preserve the total requests count (don't modify it here)
          requestsTotal: currentData.requestsTotal || 0
        };

        totalNewlyFunded += requestsToFund;
        console.log(`Processed ${url}: Funded ${requestsToFund} requests (${data.requestsOutstanding - requestsToFund} requests still outstanding, total: ${urlListData[url].requestsTotal})`);
      }
    }

    // Update the global totalFundedRequests counter
    requestCountData.totalFundedRequests = (requestCountData.totalFundedRequests || 0) + totalNewlyFunded;
    console.log(`Total newly funded requests: ${totalNewlyFunded}`);

    // Save both documents
    await setDoc(urlListRef, urlListData);
    await setDoc(requestCountRef, requestCountData);
    
    console.log('Successfully updated urlList and requestCount in Firebase');

  } catch (error) {
    console.error('Error in transferFirebaseRequestsToFunded:', error);
  }
}

export { transferFirebaseRequestsToFunded };