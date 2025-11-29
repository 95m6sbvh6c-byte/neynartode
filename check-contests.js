const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC');
const contract = new ethers.Contract(
  '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  [
    'function nextContestId() external view returns (uint256)',
  ],
  provider
);

async function main() {
  const nextId = await contract.nextContestId();
  console.log('Next contest ID:', nextId.toString());

  // Try direct call for each contest
  for (let i = 1; i <= 16; i++) {
    try {
      const data = await provider.call({
        to: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
        data: '0x904b9f72' + i.toString(16).padStart(64, '0')
      });
      const hasData = data && data.length > 66;
      console.log('Contest ' + i + ': ' + (hasData ? 'Has data (' + data.length + ' bytes)' : 'Empty/Error'));
    } catch (e) {
      console.log('Contest ' + i + ': Error');
    }
  }
}

main();
