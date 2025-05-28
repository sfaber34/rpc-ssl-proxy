import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { usdcAddress, rpcFunderContractAddress } from '../config.js';

// Minimal ABI for allowance
const usdcAbi = [
  {
    "constant": true,
    "inputs": [
      { "name": "owner", "type": "address" },
      { "name": "spender", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [ { "name": "", "type": "uint256" } ],
    "type": "function"
  }
];

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

async function getUsdcAllowance(ownerAddress) {
  try {
    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: usdcAbi,
      functionName: "allowance",
      args: [ownerAddress, rpcFunderContractAddress],
    });
    return allowance;
  } catch (error) {
    console.error("Error fetching USDC allowance:", error);
    return null;
  }
}

export { getUsdcAllowance };