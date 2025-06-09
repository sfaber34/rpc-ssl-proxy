import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function transferFirebaseRequestsToFunded(ownerRequestCounts) {
  try {
    if (Object.keys(ownerRequestCounts).length === 0) {
      console.log("ownerRequestCounts is empty");
      return;
    }
  } catch (error) {
    console.error('Error in transferFirebaseRequestsToFunded:', error);
  }
}

export { transferFirebaseRequestsToFunded };


