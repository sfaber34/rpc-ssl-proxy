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
      console.log("ipCountMap is empty - checking for hour reset only");
    } else {
      console.log(`Updating IP requests at UTC timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);
    }

    // Reference to the metadata document
    const metadataRef = db.collection(firebaseCollection).doc('metadata');
    const metadataSnap = await metadataRef.get();
    let metadataData = metadataSnap.exists ? metadataSnap.data() : {};

    // Get or initialize the global lastResetTimestamp
    let metadataNeedsInit = false;
    if (!metadataData._lastResetTimestamp) {
      console.log(`🔵 Initializing _lastResetTimestamp to ${currentTimestamp}`);
      metadataData._lastResetTimestamp = currentTimestamp;
      metadataNeedsInit = true;
    }

    const lastResetTimestamp = metadataData._lastResetTimestamp;
    const secondsSinceReset = currentTimestamp - lastResetTimestamp;
    const hourElapsed = secondsSinceReset >= 3600;

    let batch = db.batch();
    let batchCount = 0;
    const MAX_BATCH_SIZE = 500; // Firestore limit
    
    // If we just initialized metadata, save it immediately
    if (metadataNeedsInit) {
      batch.set(metadataRef, metadataData);
      batchCount++;
    }

    if (hourElapsed) {
      console.log(`⏰ An hour has elapsed since last reset (${secondsSinceReset}s) - resetting all requestsLastHour to 0`);
      
      // Query all IP documents to reset requestsLastHour
      const ipsSnapshot = await db.collection(ipsCollectionName).get();
      
      for (const doc of ipsSnapshot.docs) {
        // Check if we need to commit current batch and start a new one
        if (batchCount >= MAX_BATCH_SIZE) {
          await batch.commit();
          console.log(`Committed batch of ${batchCount} updates`);
          batch = db.batch(); // Create new batch
          batchCount = 0;
        }

        batch.update(doc.ref, { requestsLastHour: 0 });
        batchCount++;
      }
      
      // Update the reset timestamp in metadata
      metadataData._lastResetTimestamp = currentTimestamp;
      batch.set(metadataRef, metadataData);
      batchCount++;
      
      console.log(`Scheduled reset for ${ipsSnapshot.docs.length} IP documents`);
    } else if (hasNewRequests) {
      console.log(`⏱️  Time since last reset: ${secondsSinceReset}s (reset in ${3600 - secondsSinceReset}s)`);
    }

    // Update requestsTotal and requestsLastHour for each IP (only if there are new requests)
    if (hasNewRequests) {
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
          origins: {}
        };

        if (!ipDoc.exists) {
          console.log(`NEW IP added to Firebase: ${ip} with default values`);
        }

        // Initialize origins if it doesn't exist
        if (!ipDocData.origins) {
          ipDocData.origins = {};
        }

        // Update requestsTotal
        ipDocData.requestsTotal = (ipDocData.requestsTotal || 0) + requestCount;

        // Update requestsLastHour (add to current value, already reset to 0 if hour elapsed)
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
    }

    // Commit the final batch if there are any pending operations
    if (batchCount > 0) {
      console.log(`🔄 Committing batch with ${batchCount} operations to collection: ${ipsCollectionName}`);
      const result = await batch.commit();
      console.log(`✅ Committed final batch of ${batchCount} updates. Result:`, result);
      
      if (hasNewRequests) {
        console.log(`Successfully updated ${Object.keys(ipCountMap).length} IPs in Firebase collection: ${ipsCollectionName}`);
      } else if (hourElapsed) {
        console.log(`Successfully reset requestsLastHour for all IPs in Firebase`);
      }
    }

  } catch (error) {
    console.error("❌ Error updating Firebase with IP requests:", error);
    console.error("Collection name:", ipsCollectionName);
    console.error("Firestore collection:", firebaseCollection);
    throw error;
  }
}

export { updateFirebaseWithIpRequests };

