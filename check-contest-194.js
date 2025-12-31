const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

const CONTEST_MANAGER_ADDRESS = '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06';
const CONTEST_MANAGER_ABI = [
  {
    inputs: [{ name: "contestId", type: "uint256" }],
    name: "getContest",
    outputs: [
      { name: "host", type: "address" },
      { name: "tokenAddress", type: "address" },
      { name: "entryFee", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "maxEntries", type: "uint256" },
      { name: "totalEntries", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "hostFid", type: "uint256" }
    ],
    stateMutability: "view",
    type: "function"
  }
];

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
});

async function checkContest194() {
  try {
    const result = await client.readContract({
      address: CONTEST_MANAGER_ADDRESS,
      abi: CONTEST_MANAGER_ABI,
      functionName: 'getContest',
      args: [194n]
    });
    
    const [host, tokenAddress, entryFee, startTime, endTime, maxEntries, totalEntries, status, hostFid] = result;
    
    const statusMap = ['Pending', 'Active', 'Completed', 'Cancelled'];
    
    console.log('Contest 194:');
    console.log('  Host:', host);
    console.log('  Token:', tokenAddress);
    console.log('  Entry Fee:', entryFee.toString());
    console.log('  Start Time:', new Date(Number(startTime) * 1000).toISOString());
    console.log('  End Time:', new Date(Number(endTime) * 1000).toISOString());
    console.log('  Max Entries:', maxEntries.toString());
    console.log('  Total Entries:', totalEntries.toString());
    console.log('  Status:', statusMap[status] || status);
    console.log('  Host FID:', hostFid.toString());
    
    // Check if end time is in the past
    const now = Date.now();
    const endTimeMs = Number(endTime) * 1000;
    console.log('\n  Current time:', new Date(now).toISOString());
    console.log('  Is ended?:', now > endTimeMs);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkContest194();
