import { db } from './firebaseClient.js';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

async function updateFirebaseWithIpRequests(ipCountMap) {
  try {
    if (Object.keys(ipCountMap).length === 0) {
      console.log("ipCountMap is empty");
      return;
    }

    // Reference to the ipList document
    const ref = db.collection(firebaseCollection).doc('ipList');
    const docSnap = await ref.get();
    let ipListData = docSnap.exists ? docSnap.data() : {};

    // Update requestsTotal for each IP
    for (const ip in ipCountMap) {
      // If the IP is not present, add it with default values
      if (!ipListData[ip]) {
        ipListData[ip] = {
          requestsTotal: 0
        };
        console.log(`NEW IP added to Firebase: ${ip} with default values`);
      }

      // Update requestsTotal
      ipListData[ip].requestsTotal = (ipListData[ip].requestsTotal || 0) + ipCountMap[ip];
      console.log(`Updated requestsTotal for IP ${ip}: +${ipCountMap[ip]} (total: ${ipListData[ip].requestsTotal})`);
    }

    // Update the document in Firebase
    await ref.set(ipListData);
    console.log(`Successfully updated ${Object.keys(ipCountMap).length} IPs in Firebase`);

  } catch (error) {
    console.error("Error updating Firebase with IP requests:", error);
    throw error;
  }
}

export { updateFirebaseWithIpRequests };

