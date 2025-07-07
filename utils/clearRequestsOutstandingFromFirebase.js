import { db } from './firebaseClient.js';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function clearRequestsOutstandingFromFirebase() {
  try {
    const ref = db.collection(firebaseCollection).doc('urlList');
    const docSnap = await ref.get();
    
    if (docSnap.exists) {
      const data = docSnap.data();
      let hasOutstanding = false;
      
      // Set requestsOutstanding to 0 for all URLs that had outstanding requests
      for (const [url, urlData] of Object.entries(data)) {
        if (urlData && typeof urlData === 'object' && urlData.requestsOutstanding > 0) {
          data[url].requestsOutstanding = 0;
          hasOutstanding = true;
        }
      }
      
      if (hasOutstanding) {
        // Update the urlList document with cleared requestsOutstanding
        await ref.set(data);
        console.log('Successfully cleared requestsOutstanding from all URLs in Firebase');
      } else {
        console.log('No outstanding requests to clear');
      }
    } else {
      console.log('No urlList document found to clear');
    }
  } catch (error) {
    console.error('Error clearing requests outstanding from Firebase:', error);
    throw error;
  }
}

export { clearRequestsOutstandingFromFirebase };