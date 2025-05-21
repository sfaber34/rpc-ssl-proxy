import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });
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