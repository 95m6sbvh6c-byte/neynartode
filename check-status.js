const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/');
const contract = new ethers.Contract(
  '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  [
    'function nextContestId() external view returns (uint256)',
    'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  ],
  provider
);

const STATUS_NAMES = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];

async function main() {
  console.log('Contest Status Check\n');

  const contestsToCheck = [1, 2, 3, 4, 12, 13, 14, 15, 16];

  for (const id of contestsToCheck) {
    try {
      const contest = await contract.getContest(id);
      const status = Number(contest[8]);
      const winner = contest[9];
      const hasWinner = winner !== '0x0000000000000000000000000000000000000000';

      console.log('Contest #' + id + ':');
      console.log('  Status: ' + STATUS_NAMES[status] + ' (' + status + ')');
      console.log('  Winner: ' + (hasWinner ? winner : 'None'));
      console.log('');
    } catch (e) {
      console.log('Contest #' + id + ': Read Error');
      console.log('');
    }
  }
}

main();
