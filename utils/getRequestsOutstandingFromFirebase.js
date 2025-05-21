import { db } from './firebaseClient.js';
import { doc, getDoc } from 'firebase/firestore';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function getRequestsOutstandingFromFirebase() {
  const ref = doc(db, firebaseCollection, 'urlList');
  const docSnap = await getDoc(ref);
  const data = docSnap.data();
  if (!data) return {};
  // Filter for requestsOutstanding > 0 and owner set
  const filtered = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value.requestsOutstanding === 'number' &&
      value.requestsOutstanding > 0 &&
      value.owner &&
      value.owner.trim() !== ''
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export { getRequestsOutstandingFromFirebase };