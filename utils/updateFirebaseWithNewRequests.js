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
    let urlListData = {};
    if (docSnap.exists()) {
      urlListData = docSnap.data();
    }
    // Increment requestsOutstanding only if owner is non-empty
    for (const referer in urlCountMap) {
      // If the URL is not present, add it with default values
      if (!urlListData[referer]) {
        urlListData[referer] = {
          owner: "",
          requestsOutstanding: 0,
          // add other default fields if needed
        };
      }
      // Only increment if owner is non-empty
      if (
        urlListData[referer].owner &&
        urlListData[referer].owner.trim() !== ''
      ) {
        urlListData[referer].requestsOutstanding =
          (urlListData[referer].requestsOutstanding || 0) + urlCountMap[referer];
      }
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


