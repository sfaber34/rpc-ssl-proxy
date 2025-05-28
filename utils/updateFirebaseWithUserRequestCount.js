import { db } from './firebaseClient.js';
import { doc, getDoc, setDoc } from 'firebase/firestore';
const firebaseCollection = 'stage';

async function updateFirebaseWithUserRequestCount(ownerRequestCounts) {
  try {
    if (Object.keys(ownerRequestCounts).length === 0) {
      console.log("ownerRequestCounts is empty");
      return;
    }

    // Reference to the userRequestCount document in stage collection
    const ref = doc(db, firebaseCollection, 'userRequestCount');
    const docSnap = await getDoc(ref);
    let userRequestData = {};
    
    if (docSnap.exists()) {
      userRequestData = docSnap.data();
    }

    // Update request counts for each owner
    for (const [owner, count] of Object.entries(ownerRequestCounts)) {
      if (!userRequestData[owner]) {
        userRequestData[owner] = {
          totalRequests: 0,
          lastUpdated: new Date().toISOString()
        };
      }
      
      // Increment total requests for the owner
      userRequestData[owner].totalRequests = 
        (userRequestData[owner].totalRequests || 0) + count;
      userRequestData[owner].lastUpdated = new Date().toISOString();
      
      console.log(`Updating Firebase for ${owner}: +${count} requests (total: ${userRequestData[owner].totalRequests})`);
    }

    await setDoc(ref, userRequestData);
    console.log('Firebase userRequestCount updated successfully.');
  } catch (error) {
    console.error('Error updating userRequestCount:', error);
  }
}

export { updateFirebaseWithUserRequestCount };


