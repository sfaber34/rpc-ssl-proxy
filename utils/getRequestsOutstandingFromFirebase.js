import { db } from './firebaseClient.js';

const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function getRequestsOutstandingFromFirebase() {
  try {
    const ref = db.collection(firebaseCollection).doc('urlList');
    const docSnap = await ref.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      const requestsOutstanding = {};
      
      // Extract URLs that have requestsOutstanding > 0
      for (const [url, urlData] of Object.entries(data)) {
        if (urlData && typeof urlData === 'object' && urlData.requestsOutstanding > 0) {
          requestsOutstanding[url] = {
            requestsOutstanding: urlData.requestsOutstanding
          };
        }
      }
      
      console.log('Retrieved requests outstanding from Firebase:', requestsOutstanding);
      return requestsOutstanding;
    } else {
      console.log('No urlList document found');
      return {};
    }
  } catch (error) {
    console.error('Error getting requests outstanding from Firebase:', error);
    throw error;
  }
}

export { getRequestsOutstandingFromFirebase };