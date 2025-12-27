/**
 * Emergency Release Script
 *
 * Use this to manually release prizes when VRF fails or takes too long
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/emergency-release.js <contestId> <winnerAddress>
 *
 * Example:
 *   PRIVATE_KEY=0x... node scripts/emergency-release.js 5 0xf3542fbF2063Fe397932ad3D35f3AE7ee9A4E7E1
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/'
};

const ABI = [
  'function emergencyRelease(uint256 _contestId, address _winner) external',
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function owner() view returns (address)'
];

async function main() {
  const contestId = process.argv[2];
  const winnerAddress = process.argv[3];

  if (!contestId) {
    console.log('Usage: PRIVATE_KEY=0x... node scripts/emergency-release.js <contestId> [winnerAddress]');
    console.log('');
    console.log('If winnerAddress is not provided, will show qualified entries to choose from.');
    return;
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, provider);

  // Get contest info
  const c = await contract.getContest(contestId);
  const statusNames = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];

  console.log('=== Contest #' + contestId + ' ===');
  console.log('Status:', statusNames[Number(c[8])]);
  console.log('Host:', c[0]);
  console.log('Prize:', c[1] === '0x0000000000000000000000000000000000000000'
    ? ethers.formatEther(c[2]) + ' ETH'
    : ethers.formatEther(c[2]) + ' tokens (' + c[1] + ')');
  console.log('Current Winner:', c[9] === '0x0000000000000000000000000000000000000000' ? 'None' : c[9]);
  console.log('');

  // Get qualified entries
  const entries = await contract.getQualifiedEntries(contestId);
  console.log('Qualified Entries (' + entries.length + '):');
  entries.forEach((e, i) => console.log('  ' + (i + 1) + '. ' + e));
  console.log('');

  if (Number(c[8]) === 2) {
    console.log('Contest already completed!');
    return;
  }

  if (Number(c[8]) === 3) {
    console.log('Contest was cancelled!');
    return;
  }

  if (!winnerAddress) {
    console.log('To release to a winner, run:');
    console.log('  PRIVATE_KEY=0x... node scripts/emergency-release.js ' + contestId + ' <address>');
    console.log('');
    console.log('Pick one of the qualified entries above.');
    return;
  }

  // Validate winner is in qualified list
  const isQualified = entries.some(e => e.toLowerCase() === winnerAddress.toLowerCase());
  if (!isQualified && entries.length > 0) {
    console.log('WARNING: Address is not in qualified entries list!');
    console.log('Proceeding anyway (emergency release allows any address)...');
  }

  if (!process.env.PRIVATE_KEY) {
    console.log('ERROR: PRIVATE_KEY not set');
    return;
  }

  const privateKey = process.env.PRIVATE_KEY.trim().replace(/\\n/g, '');
  const wallet = new ethers.Wallet(privateKey, provider);
  const owner = await contract.owner();

  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error('ERROR: Wallet is not the contract owner!');
    console.error('Owner:', owner);
    console.error('Your wallet:', wallet.address);
    return;
  }

  const contractSigner = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, wallet);

  console.log('=== Executing Emergency Release ===');
  console.log('Winner:', winnerAddress);

  const tx = await contractSigner.emergencyRelease(contestId, winnerAddress);
  console.log('TX submitted:', tx.hash);
  console.log('Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log('Confirmed in block:', receipt.blockNumber);
  console.log('Gas used:', receipt.gasUsed.toString());
  console.log('');
  console.log('Prize released to:', winnerAddress);
}

main().catch(console.error);
