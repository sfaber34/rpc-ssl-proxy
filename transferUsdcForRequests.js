import { transferUsdc } from './utils/transferUsdc.js';
// import { getUsdcAllowance } from './utils/getUsdcAllowance.js';
import { getRequestsOutstandingFromFirebase } from './utils/getRequestsOutstandingFromFirebase.js';
import { getUsdcAllowance } from './utils/getUsdcAllowance.js';

async function transferUsdcForRequests() {
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

  // For each owner, get and log their USDC allowance
  for (const [owner, count] of Object.entries(ownerRequestCounts)) {
    const allowance = await getUsdcAllowance(owner);
    console.log(`Owner: ${owner}, Requests Outstanding: ${count}, USDC Allowance: ${allowance}`);
  }
}

transferUsdcForRequests();

// const ownerAddress = "0x4dBd522584027518dF620479947aB110d8C998af";
// const allowance = await getUsdcAllowance(ownerAddress);
// console.log("Allowance:", allowance);

// transferUsdc(
//   [
//     "0x4dBd522584027518dF620479947aB110d8C998af",
//   ],
//   [1]
// );