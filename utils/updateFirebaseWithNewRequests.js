import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

// Global map: key = referer URL, value = count
const urlCountMap = {};

// Increment the count for a single referer URL
function updateUrlCountMap(referer) {
    if (!referer) return;
    // Clean the referer: remove protocol and trailing slash
    let cleaned = referer.replace(/^https?:\/\//, '').replace(/\/$/, '');
    urlCountMap[cleaned] = (urlCountMap[cleaned] || 0) + 1;
    console.log("urlCountMap", urlCountMap);
}

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
      if (
        urlListData[referer] &&
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
    console.log('urlList updated and urlCountMap cleared.');
  } catch (error) {
    console.error('Error updating urlList:', error);
  }
}

export { updateFirebaseWithNewRequests, updateUrlCountMap, urlCountMap };


