import { db } from './firebaseClient.js';
import { doc, getDoc } from 'firebase/firestore';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function getRequestsOutstandingFromFirebase() {
  try {
    const ref = doc(db, firebaseCollection, 'urlList');
    const docSnap = await getDoc(ref);
    const data = docSnap.data();
    if (!data) return {};

    // Filter for requestsOutstanding > 0
    const filtered = {};
    for (const [key, value] of Object.entries(data)) {
      if (
        value &&
        typeof value.requestsOutstanding === 'number' &&
        value.requestsOutstanding > 0
      ) {
        filtered[key] = value;
      }
    }
    return filtered;
  } catch (error) {
    console.error('Error in getRequestsOutstandingFromFirebase:', error);
    return {};
  }
}

export { getRequestsOutstandingFromFirebase };