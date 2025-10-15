import { db } from './firebaseClient.js';
const firebaseCollection = process.env.FIREBASE_COLLECTION;

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

    // Reference to the ipList document
    const ref = db.collection(firebaseCollection).doc('ipList');
    const docSnap = await ref.get();
    let ipListData = docSnap.exists ? docSnap.data() : {};

    // Get or initialize the global lastResetTimestamp
    if (!ipListData._lastResetTimestamp) {
      console.log(`🔵 Initializing _lastResetTimestamp to ${currentTimestamp}`);
      ipListData._lastResetTimestamp = currentTimestamp;
    }

    const lastResetTimestamp = ipListData._lastResetTimestamp;
    const secondsSinceReset = currentTimestamp - lastResetTimestamp;
    const minuteElapsed = secondsSinceReset >= 60;

    let needsUpdate = false;

    if (minuteElapsed) {
      console.log(`⏰ A minute has elapsed since last reset (${secondsSinceReset}s) - resetting all requestsLastMinute to 0`);
      
      // Reset requestsLastMinute for ALL IPs
      for (const key in ipListData) {
        if (key !== '_lastResetTimestamp' && ipListData[key].requestsLastMinute !== undefined) {
          ipListData[key].requestsLastMinute = 0;
        }
      }
      
      // Update the reset timestamp
      ipListData._lastResetTimestamp = currentTimestamp;
      needsUpdate = true;
    } else if (hasNewRequests) {
      console.log(`⏱️  Time since last reset: ${secondsSinceReset}s (reset in ${60 - secondsSinceReset}s)`);
    }

    // Update requestsTotal and requestsLastMinute for each IP (only if there are new requests)
    if (hasNewRequests) {
      for (const ip in ipCountMap) {
        // If the IP is not present, add it with default values
        if (!ipListData[ip]) {
          ipListData[ip] = {
            requestsTotal: 0,
            requestsLastMinute: 0
          };
          console.log(`NEW IP added to Firebase: ${ip} with default values`);
        }

        // Update requestsTotal
        ipListData[ip].requestsTotal = (ipListData[ip].requestsTotal || 0) + ipCountMap[ip];

        // Update requestsLastMinute (add to current value, already reset to 0 if minute elapsed)
        ipListData[ip].requestsLastMinute = (ipListData[ip].requestsLastMinute || 0) + ipCountMap[ip];

        console.log(`Updated IP ${ip}: +${ipCountMap[ip]} requests | Total: ${ipListData[ip].requestsTotal} | Last Minute: ${ipListData[ip].requestsLastMinute}`);
      }
      needsUpdate = true;
    }

    // Update the document in Firebase only if something changed
    if (needsUpdate) {
      await ref.set(ipListData);
      if (hasNewRequests) {
        console.log(`Successfully updated ${Object.keys(ipCountMap).length} IPs in Firebase`);
      } else {
        console.log(`Successfully reset requestsLastMinute for all IPs in Firebase`);
      }
    }

  } catch (error) {
    console.error("Error updating Firebase with IP requests:", error);
    throw error;
  }
}

export { updateFirebaseWithIpRequests };

