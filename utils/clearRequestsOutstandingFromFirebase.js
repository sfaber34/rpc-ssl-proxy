import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

// Accepts an array of URLs
async function clearRequestsOutstandingFromFirebase(urls) {
  try {
    if (!Array.isArray(urls) || urls.length === 0) return {};

    const ref = doc(db, firebaseCollection, 'urlList');
    const docSnap = await getDoc(ref);
    const data = docSnap.data();
    if (!data) return {};

    let updated = false;
    const urlSet = new Set(urls);

    for (const [key, value] of Object.entries(data)) {
      if (
        value &&
        typeof value.requestsOutstanding === 'number' &&
        urlSet.has(key)
      ) {
        if (value.requestsOutstanding !== 0) {
          data[key].requestsOutstanding = 0;
          updated = true;
        }
      }
    }

    if (updated) {
      await setDoc(ref, data);
    }
    return data;
  } catch (error) {
    console.error('Error in clearRequestsOutstandingFromFirebase:', error);
    return {};
  }
}

export { clearRequestsOutstandingFromFirebase };