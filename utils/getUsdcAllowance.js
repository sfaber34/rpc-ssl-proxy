import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const spender = "0x291469065a4DDdE2CA9f6A53ab4Aa148B8e42f48";

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
      args: [ownerAddress, spender],
    });
    return allowance;
  } catch (error) {
    console.error("Error fetching USDC allowance:", error);
    return null;
  }
}

export { getUsdcAllowance };