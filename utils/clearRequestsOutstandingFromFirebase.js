import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

// Accepts an array of user addresses
async function clearRequestsOutstandingFromFirebase(users) {
  try {
    if (!Array.isArray(users) || users.length === 0) return {};
    const ref = doc(db, firebaseCollection, 'urlList');
    const docSnap = await getDoc(ref);
    const data = docSnap.data();
    if (!data) return {};
    let updated = false;
    // Lowercase all user addresses for case-insensitive match
    const userSet = new Set(users.map(u => u.toLowerCase()));
    for (const [key, value] of Object.entries(data)) {
      if (
        value &&
        typeof value.requestsOutstanding === 'number' &&
        value.owner &&
        value.owner.trim() !== '' &&
        userSet.has(value.owner.toLowerCase())
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