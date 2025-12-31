const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

const CONTEST_MANAGER_V2 = '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06';

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
});

const V2_ABI = [
  {
    inputs: [{ name: "_contestId", type: "uint256" }],
    name: "getContest",
    outputs: [
      { name: "host", type: "address" },
      { name: "contestType", type: "uint8" },
      { name: "status", type: "uint8" },
      { name: "castId", type: "string" },
      { name: "endTime", type: "uint256" },
      { name: "prizeToken", type: "address" },
      { name: "prizeAmount", type: "uint256" },
      { name: "winnerCount", type: "uint8" },
      { name: "winners", type: "address[]" }
    ],
    stateMutability: "view",
    type: "function"
  }
];

async function check() {
  console.log("Checking contests 190-200 on ContestManager V2...\n");
  
  for (let i = 190; i <= 200; i++) {
    try {
      const data = await client.readContract({
        address: CONTEST_MANAGER_V2,
        abi: V2_ABI,
        functionName: "getContest",
        args: [BigInt(i)]
      });
      
      const statusMap = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];
      const typeMap = ['ETH', 'ERC20', 'NFT'];
      
      console.log("Contest " + i + ":");
      console.log("  Host: " + data[0].substring(0,12) + "...");
      console.log("  Type: " + (typeMap[data[1]] || data[1]));
      console.log("  Status: " + (statusMap[data[2]] || data[2]));
      console.log("  End Time: " + new Date(Number(data[4]) * 1000).toISOString());
      console.log("  Prize Token: " + data[5].substring(0,12) + "...");
      console.log("  Winners: " + data[8].length);
      console.log("");
    } catch (e) {
      console.log("Contest " + i + ": Error - " + e.message.substring(0,60));
      console.log("");
    }
  }
}

check();
