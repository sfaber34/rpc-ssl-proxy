import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function updateFirebaseWithNewRequests(urlCountMap) {
  try {
    if (Object.keys(urlCountMap).length === 0) {
      console.log("urlCountMap is empty");
      return;
    }

    // Reference to the urlList document
    const ref = doc(db, firebaseCollection, 'urlList');
    const docSnap = await getDoc(ref);
    let urlListData = docSnap.exists() ? docSnap.data() : {};

    // Update requestsOutstanding for each URL
    for (const referer in urlCountMap) {
      // If the URL is not present, add it with default values
      if (!urlListData[referer]) {
        urlListData[referer] = {
          requestsRemaining: 0,
          requestsOutstanding: 0
        };
      }

      const newRequests = urlCountMap[referer];
      urlListData[referer].requestsOutstanding = 
        (urlListData[referer].requestsOutstanding || 0) + newRequests;
      
      console.log(`Updating Firebase for ${referer}: +${newRequests} requests (total outstanding: ${urlListData[referer].requestsOutstanding}, remaining: ${urlListData[referer].requestsRemaining})`);
    }

    await setDoc(ref, urlListData);
    
    // Clear urlCountMap
    for (const key in urlCountMap) {
      delete urlCountMap[key];
    }
    console.log('Firebase urlList updated and urlCountMap cleared.');
  } catch (error) {
    console.error('Error updating urlList:', error);
  }
}

export { updateFirebaseWithNewRequests };


