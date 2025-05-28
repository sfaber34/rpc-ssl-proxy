import { transferUsdc } from './transferUsdc.js';
import { getRequestsOutstandingFromFirebase } from './getRequestsOutstandingFromFirebase.js';
import { clearRequestsOutstandingFromFirebase } from './clearRequestsOutstandingFromFirebase.js';
import { getUsdcAllowance } from './getUsdcAllowance.js';
import { getUsdcBalance } from './getUsdcBalance.js';
import { updateFirebaseWithUserRequestCount } from './updateFirebaseWithUserRequestCount.js';

async function batchTransferUsdcForRequests() {
  try {
    const requestsOutstanding = await getRequestsOutstandingFromFirebase();
    console.log("Requests outstanding:", requestsOutstanding);

    // Aggregate requestsOutstanding by owner
    const ownerRequestCounts = {};
    for (const [site, data] of Object.entries(requestsOutstanding)) {
      if (data.owner && typeof data.requestsOutstanding === 'number') {
        if (!ownerRequestCounts[data.owner]) {
          ownerRequestCounts[data.owner] = 0;
        }
        ownerRequestCounts[data.owner] += data.requestsOutstanding;
      }
    }

    // Prepare arrays for owners and amounts to transfer
    const ownersToTransfer = [];
    const amountsToTransfer = [];
    const successfulOwnerCounts = {};

    // For each owner, get and log their USDC allowance and balance
    for (const [owner, count] of Object.entries(ownerRequestCounts)) {
      try {
        const [allowance, balance] = await Promise.all([
          getUsdcAllowance(owner),
          getUsdcBalance(owner)
        ]);
        console.log(`Owner: ${owner}, Requests Outstanding: ${count}, USDC Allowance: ${allowance}, USDC Balance: ${balance}`);
        if (allowance >= count && balance >= count) {
          console.log(`Will transfer ${count / 1000000} USDC from owner ${owner}`);
          ownersToTransfer.push(owner);
          amountsToTransfer.push(count);
          successfulOwnerCounts[owner] = count;
        } else {
          if (allowance < count) {
            console.log(`Owner ${owner} does not have enough allowance for ${count} transfers (allowance: ${allowance})`);
          }
          if (balance < count) {
            console.log(`Owner ${owner} does not have enough USDC balance for ${count} transfers (balance: ${balance})`);
          }
        }
      } catch (error) {
        console.error(`Error processing owner ${owner}:`, error);
        continue; // Skip this owner and continue with others
      }
    }

    // Call transferUsdc if there are any eligible owners
    if (ownersToTransfer.length > 0) {
      try {
        console.log(`Initiated transfer for owners:`, ownersToTransfer);
        await transferUsdc(ownersToTransfer, amountsToTransfer);
        await clearRequestsOutstandingFromFirebase(ownersToTransfer);
        // Update the total request counts in Firebase for successful transfers
        await updateFirebaseWithUserRequestCount(successfulOwnerCounts);
      } catch (error) {
        console.error('Error during transfer or clearing:', error);
      }
    } else {
      console.log('No owners eligible for transfer.');
    }
  } catch (error) {
    console.error('Error in batchTransferUsdcForRequests:', error);
  }
  return; // Explicitly return undefined to prevent any error propagation
}

export { batchTransferUsdcForRequests };