const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

const CONTEST_MANAGER_ADDRESS = '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06';

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
});

async function checkContest() {
  const nextId = await client.readContract({
    address: CONTEST_MANAGER_ADDRESS,
    abi: [{ inputs: [], name: "nextContestId", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }],
    functionName: 'nextContestId'
  });
  
  console.log('Next Contest ID:', nextId.toString());
  
  console.log('\nChecking contests 193-197...');
  for (let i = 193; i <= 197; i++) {
    try {
      const data = await client.readContract({
        address: CONTEST_MANAGER_ADDRESS,
        abi: [{
          inputs: [{ name: "", type: "uint256" }],
          name: "contests",
          outputs: [
            { name: "host", type: "address" },
            { name: "prizeToken", type: "address" },
            { name: "prizeAmount", type: "uint256" },
            { name: "startTime", type: "uint256" },
            { name: "endTime", type: "uint256" },
            { name: "durationHours", type: "uint8" },
            { name: "durationMinutes", type: "uint8" },
            { name: "castId", type: "bytes32" },
            { name: "tokenRequirement", type: "address" },
            { name: "volumeRequirement", type: "uint256" },
            { name: "status", type: "uint8" },
            { name: "winnerCount", type: "uint8" },
            { name: "participantCount", type: "uint256" },
            { name: "requireRecast", type: "bool" },
            { name: "requireLike", type: "bool" },
            { name: "requireReply", type: "bool" }
          ],
          stateMutability: "view",
          type: "function"
        }],
        functionName: 'contests',
        args: [BigInt(i)]
      });
      const statusMap = ['Pending', 'Active', 'Completed', 'Cancelled'];
      const host = data[0];
      const status = data[10];
      const startTime = data[3];
      console.log('Contest ' + i + ': Host=' + host.substring(0,10) + '..., Status=' + (statusMap[status] || status) + ', StartTime=' + new Date(Number(startTime) * 1000).toISOString());
    } catch (e) {
      console.log('Contest ' + i + ': Error - ' + e.message.substring(0, 50));
    }
  }
}

checkContest();
