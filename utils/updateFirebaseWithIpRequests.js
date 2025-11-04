import { db } from './firebaseClient.js';
const firebaseCollection = process.env.FIREBASE_COLLECTION;
const ipsCollectionName = `${firebaseCollection}Ips`;

// Helper function to get current UTC timestamp in seconds
function getCurrentUTCTimestamp() {
  return Math.floor(Date.now() / 1000);
}

async function updateFirebaseWithIpRequests(ipCountMap) {
  try {
    const currentTimestamp = getCurrentUTCTimestamp();
    const hasNewRequests = Object.keys(ipCountMap).length > 0;

    if (!hasNewRequests) {
      console.log("ipCountMap is empty - no updates needed");
      return;
    }

    console.log(`Updating IP requests at UTC timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);

    let batch = db.batch();
    let batchCount = 0;
    const MAX_BATCH_SIZE = 500; // Firestore limit

    // Update requestsTotal and requestsLastHour for each IP with lazy reset
    for (const ip in ipCountMap) {
      const ipData = ipCountMap[ip];
      const requestCount = ipData.count || 0;
      const origins = ipData.origins || {};

      // Check if we need to commit current batch and start a new one
      if (batchCount >= MAX_BATCH_SIZE) {
        await batch.commit();
        console.log(`Committed batch of ${batchCount} updates`);
        batch = db.batch(); // Create new batch
        batchCount = 0;
      }

      // Reference to the IP document
      const ipRef = db.collection(ipsCollectionName).doc(ip);
      const ipDoc = await ipRef.get();

      let ipDocData = ipDoc.exists ? ipDoc.data() : {
        requestsTotal: 0,
        requestsLastHour: 0,
        lastResetTimestamp: currentTimestamp,
        origins: {}
      };

      if (!ipDoc.exists) {
        console.log(`NEW IP added to Firebase: ${ip} with default values`);
      }

      // Initialize fields if they don't exist
      if (!ipDocData.origins) {
        ipDocData.origins = {};
      }
      if (!ipDocData.lastResetTimestamp) {
        ipDocData.lastResetTimestamp = currentTimestamp;
      }

      // LAZY RESET: Check if hour has elapsed for this specific IP
      const secondsSinceReset = currentTimestamp - (ipDocData.lastResetTimestamp || 0);
      const hourElapsed = secondsSinceReset >= 3600;

      if (hourElapsed) {
        console.log(`⏰ Resetting requestsLastHour for IP ${ip} (${secondsSinceReset}s since last reset)`);
        ipDocData.requestsLastHour = 0;
        ipDocData.lastResetTimestamp = currentTimestamp;
      }

      // Update requestsTotal
      ipDocData.requestsTotal = (ipDocData.requestsTotal || 0) + requestCount;

      // Update requestsLastHour
      ipDocData.requestsLastHour = (ipDocData.requestsLastHour || 0) + requestCount;

      // Update origins - merge the counts
      for (const origin in origins) {
        if (!ipDocData.origins[origin]) {
          ipDocData.origins[origin] = 0;
        }
        ipDocData.origins[origin] += origins[origin];
      }

      batch.set(ipRef, ipDocData);
      batchCount++;

      console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${ipDocData.requestsTotal} | Last Hour: ${ipDocData.requestsLastHour} | Origins: ${JSON.stringify(ipDocData.origins)}`);
    }

    // Commit the final batch if there are any pending operations
    if (batchCount > 0) {
      console.log(`🔄 Committing batch with ${batchCount} operations to collection: ${ipsCollectionName}`);
      const result = await batch.commit();
      console.log(`✅ Committed final batch of ${batchCount} updates. Result:`, result);
      console.log(`Successfully updated ${Object.keys(ipCountMap).length} IPs in Firebase collection: ${ipsCollectionName}`);
    }

  } catch (error) {
    console.error("❌ Error updating Firebase with IP requests:", error);
    console.error("Collection name:", ipsCollectionName);
    console.error("Firestore collection:", firebaseCollection);
    throw error;
  }
}

export { updateFirebaseWithIpRequests };

