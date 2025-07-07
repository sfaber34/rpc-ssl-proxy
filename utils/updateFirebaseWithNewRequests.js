import { db } from './firebaseClient.js';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function updateFirebaseWithNewRequests(urlCountMap) {
  try {
    if (Object.keys(urlCountMap).length === 0) {
      console.log("urlCountMap is empty");
      return;
    }

    // Reference to the urlList document
    const ref = db.collection(firebaseCollection).doc('urlList');
    const docSnap = await ref.get();
    let urlListData = docSnap.exists ? docSnap.data() : {};

    // Update requestsOutstanding and requestsTotal for each URL
    for (const referer in urlCountMap) {
      // If the URL is not present, add it with default values
      if (!urlListData[referer]) {
        urlListData[referer] = {
          requestsRemaining: 0,
          requestsOutstanding: 0,
          requestsTotal: 0
        };
        console.log(`NEW URL added to Firebase: ${referer} with default values`);
      } else {
        // Initialize requestsTotal if it doesn't exist (for existing URLs)
        if (urlListData[referer].requestsTotal === undefined) {
          urlListData[referer].requestsTotal = 0;
        }
      }

      // Only update requestsOutstanding if the URL has funding (requestsRemaining > 0)
      if (urlListData[referer].requestsRemaining > 0) {
        urlListData[referer].requestsOutstanding = (urlListData[referer].requestsOutstanding || 0) + urlCountMap[referer];
        console.log(`Updated requestsOutstanding for ${referer}: +${urlCountMap[referer]} (has ${urlListData[referer].requestsRemaining} remaining)`);
      } else {
        console.log(`Skipped requestsOutstanding update for ${referer}: no funding (${urlCountMap[referer]} requests)`);
      }

      // Always update requestsTotal regardless of funding status
      urlListData[referer].requestsTotal = (urlListData[referer].requestsTotal || 0) + urlCountMap[referer];
      console.log(`Updated requestsTotal for ${referer}: +${urlCountMap[referer]} (total: ${urlListData[referer].requestsTotal})`);
    }

    // Update the document in Firebase
    await ref.set(urlListData);
    console.log(`Successfully updated ${Object.keys(urlCountMap).length} URLs in Firebase`);

  } catch (error) {
    console.error("Error updating Firebase with new requests:", error);
    throw error;
  }
}

export { updateFirebaseWithNewRequests };


