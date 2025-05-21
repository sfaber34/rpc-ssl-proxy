const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
require('dotenv').config();
const firebaseCollection = process.env.FIREBASE_COLLECTION;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Global map: key = referer URL, value = count
const countMap = {};

// Increment the count for a single referer URL
function trackReferersByCount(referer) {
    if (!referer) return;
    // Clean the referer: remove protocol and trailing slash
    let cleaned = referer.replace(/^https?:\/\//, '').replace(/\/$/, '');
    countMap[cleaned] = (countMap[cleaned] || 0) + 1;
    console.log("countMap", countMap);
}

async function updateFirebase(countMap) {
  try {
    if (Object.keys(countMap).length === 0) {
      console.log("countMap is empty");
      return;
    } 
    const ref = doc(db, firebaseCollection, 'requestsOutstanding');
    const docSnap = await getDoc(ref);
    let firebaseData = {};
    if (docSnap.exists()) {
      firebaseData = docSnap.data();
    }
    // Increment counts
    for (const referer in countMap) {
      if (firebaseData[referer]) {
        firebaseData[referer] += countMap[referer];
      } else {
        firebaseData[referer] = countMap[referer];
      }
    }
    await setDoc(ref, firebaseData);
    // Clear countMap
    for (const key in countMap) {
      delete countMap[key];
    }
    console.log('Firebase updated and countMap cleared.');
  } catch (error) {
    console.error('Error updating Firebase:', error);
  }
}

// Call updateFirebase every minute
setInterval(() => updateFirebase(countMap), 60 * 1000);

module.exports = { trackReferersByCount };
