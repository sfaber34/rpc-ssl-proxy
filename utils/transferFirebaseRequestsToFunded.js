import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getRequestsOutstandingFromFirebase } from './getRequestsOutstandingFromFirebase.js';
import { clearRequestsOutstandingFromFirebase } from './clearRequestsOutstandingFromFirebase.js';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function transferFirebaseRequestsToFunded() {
  try {
    const requestsOutstanding = await getRequestsOutstandingFromFirebase();
    console.log("Requests outstanding:", requestsOutstanding);

    // Aggregate requestsOutstanding by owner
    const ownerRequestCounts = {};
    for (const [site, data] of Object.entries(requestsOutstanding)) {
      if (data.owner && typeof data.requestsOutstanding === 'number') {
        if (!ownerRequestCounts[data.owner]) {
          ownerRequestCounts[data.owner] = 0;
        }
        ownerRequestCounts[data.owner] += data.requestsOutstanding;
      }
    }

    // Get the userRequestCount document
    const userRequestCountRef = doc(db, firebaseCollection, 'userRequestCount');
    const userRequestCountSnap = await getDoc(userRequestCountRef);
    let userRequestData = userRequestCountSnap.exists() ? userRequestCountSnap.data() : {};

    // Update the request counts for each owner
    for (const [owner, count] of Object.entries(ownerRequestCounts)) {
      if (!userRequestData[owner]) {
        userRequestData[owner] = {
          requestsRemaining: 0,
          requestsFunded: 0,
          lastUpdated: new Date().toISOString()
        };
      }

      // Move requests from remaining to funded
      userRequestData[owner].requestsRemaining = Math.max(0, (userRequestData[owner].requestsRemaining || 0) - count);
      userRequestData[owner].requestsFunded = (userRequestData[owner].requestsFunded || 0) + count;
      userRequestData[owner].lastUpdated = new Date().toISOString();

      console.log(`Updated ${owner}: Moved ${count} requests from remaining to funded`);
    }

    // Save the updated userRequestCount document
    await setDoc(userRequestCountRef, userRequestData);
    console.log('Successfully updated userRequestCount in Firebase');

    // Clear the outstanding requests from urlList
    const ownersToClear = Object.keys(ownerRequestCounts);
    if (ownersToClear.length > 0) {
      await clearRequestsOutstandingFromFirebase(ownersToClear);
      console.log('Cleared outstanding requests from urlList');
    } else {
      console.log('No owners to clear from urlList');
    }

  } catch (error) {
    console.error('Error in transferFirebaseRequestsToFunded:', error);
  }
}

export { transferFirebaseRequestsToFunded };