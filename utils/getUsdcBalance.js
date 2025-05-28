import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { usdcAddress } from '../config.js';

// Minimal ABI for balanceOf
const usdcAbi = [
  {
    "constant": true,
    "inputs": [
      { "name": "account", "type": "address" }
    ],
    "name": "balanceOf",
    "outputs": [ { "name": "", "type": "uint256" } ],
    "type": "function"
  }
];

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

async function getUsdcBalance(ownerAddress) {
  try {
    const balance = await publicClient.readContract({
      address: usdcAddress,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [ownerAddress],
    });
    return balance;
  } catch (error) {
    console.error("Error fetching USDC balance:", error);
    return null;
  }
}

export { getUsdcBalance };