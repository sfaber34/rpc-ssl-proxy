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
      console.log("ipCountMap is empty - checking for minute reset only");
    } else {
      console.log(`Updating IP requests at UTC timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);
    }

    // Reference to the metadata document
    const metadataRef = db.collection(firebaseCollection).doc('metadata');
    const metadataSnap = await metadataRef.get();
    let metadataData = metadataSnap.exists ? metadataSnap.data() : {};

    // Get or initialize the global lastResetTimestamp
    if (!metadataData._lastResetTimestamp) {
      console.log(`🔵 Initializing _lastResetTimestamp to ${currentTimestamp}`);
      metadataData._lastResetTimestamp = currentTimestamp;
    }

    const lastResetTimestamp = metadataData._lastResetTimestamp;
    const secondsSinceReset = currentTimestamp - lastResetTimestamp;
    const minuteElapsed = secondsSinceReset >= 60;

    let batch = db.batch();
    let batchCount = 0;
    const MAX_BATCH_SIZE = 500; // Firestore limit

    if (minuteElapsed) {
      console.log(`⏰ A minute has elapsed since last reset (${secondsSinceReset}s) - resetting all requestsLastMinute to 0`);
      
      // Query all IP documents to reset requestsLastMinute
      const ipsSnapshot = await db.collection(ipsCollectionName).get();
      
      for (const doc of ipsSnapshot.docs) {
        // Check if we need to commit current batch and start a new one
        if (batchCount >= MAX_BATCH_SIZE) {
          await batch.commit();
          console.log(`Committed batch of ${batchCount} updates`);
          batch = db.batch(); // Create new batch
          batchCount = 0;
        }

        batch.update(doc.ref, { requestsLastMinute: 0 });
        batchCount++;
      }
      
      // Update the reset timestamp in metadata
      metadataData._lastResetTimestamp = currentTimestamp;
      batch.set(metadataRef, metadataData);
      batchCount++;
      
      console.log(`Scheduled reset for ${ipsSnapshot.docs.length} IP documents`);
    } else if (hasNewRequests) {
      console.log(`⏱️  Time since last reset: ${secondsSinceReset}s (reset in ${60 - secondsSinceReset}s)`);
    }

    // Update requestsTotal and requestsLastMinute for each IP (only if there are new requests)
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
          requestsLastMinute: 0,
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

        // Update requestsLastMinute (add to current value, already reset to 0 if minute elapsed)
        ipDocData.requestsLastMinute = (ipDocData.requestsLastMinute || 0) + requestCount;

        // Update origins - merge the counts
        for (const origin in origins) {
          if (!ipDocData.origins[origin]) {
            ipDocData.origins[origin] = 0;
          }
          ipDocData.origins[origin] += origins[origin];
        }

        batch.set(ipRef, ipDocData);
        batchCount++;

        console.log(`Updated IP ${ip}: +${requestCount} requests | Total: ${ipDocData.requestsTotal} | Last Minute: ${ipDocData.requestsLastMinute} | Origins: ${JSON.stringify(ipDocData.origins)}`);
      }
    }

    // Commit the final batch if there are any pending operations
    if (batchCount > 0) {
      console.log(`🔄 Committing batch with ${batchCount} operations to collection: ${ipsCollectionName}`);
      const result = await batch.commit();
      console.log(`✅ Committed final batch of ${batchCount} updates. Result:`, result);
      
      if (hasNewRequests) {
        console.log(`Successfully updated ${Object.keys(ipCountMap).length} IPs in Firebase collection: ${ipsCollectionName}`);
      } else if (minuteElapsed) {
        console.log(`Successfully reset requestsLastMinute for all IPs in Firebase`);
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

