const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
const CONTRACT = '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A';

// ABI for individual fields
const ABI = [
  'function nextContestId() view returns (uint256)',
  'function getContest(uint256) view returns (address,address,uint256,uint256,uint256,string,address,uint256,uint8,address)',
];

const contract = new ethers.Contract(CONTRACT, ABI, provider);
const STATUS = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];

async function main() {
  const nextId = await contract.nextContestId();
  console.log('Total contests:', (nextId - 1n).toString());
  console.log('');

  for (let i = 1n; i < nextId; i++) {
    try {
      const c = await contract.getContest(i);
      const status = Number(c[8]);
      const winner = c[9];
      const prize = ethers.formatEther(c[2]);

      console.log('Contest #' + i + ': ' + STATUS[status] +
        (winner !== '0x0000000000000000000000000000000000000000' ? ' | Winner: ' + winner.slice(0,10) + '...' : '') +
        ' | Prize: ' + prize + ' tokens');
    } catch (e) {
      console.log('Contest #' + i + ': ERROR reading');
    }
  }
}

main().catch(console.error);
