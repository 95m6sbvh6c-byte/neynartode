/**
 * Cancel Stuck Contests
 *
 * Script to cancel contests stuck in PendingVRF (status 1)
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
};

// Extended ABI with potential cancel functions
const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
  'function cancelContest(uint256 _contestId, string calldata _reason) external',
  'function emergencyCancel(uint256 _contestId) external',
  'function forceCancel(uint256 _contestId) external',
  'function adminCancel(uint256 _contestId) external',
  'function owner() external view returns (address)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Check if PRIVATE_KEY is set
  if (!process.env.PRIVATE_KEY) {
    console.log('❌ PRIVATE_KEY not set in environment');
    console.log('Run: export PRIVATE_KEY=your_private_key');
    process.exit(1);
  }

  // Clean the private key (remove newlines/whitespace)
  const privateKey = process.env.PRIVATE_KEY.trim().replace(/\\n/g, '');
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`🔑 Using wallet: ${wallet.address}`);

  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    wallet
  );

  // Check owner
  try {
    const owner = await contestEscrow.owner();
    console.log(`📋 Contract owner: ${owner}`);
    console.log(`   You are owner: ${owner.toLowerCase() === wallet.address.toLowerCase()}`);
  } catch (e) {
    console.log('   Could not get owner');
  }

  // Get all contests
  const nextId = await contestEscrow.nextContestId();
  console.log(`\n📊 Total contests: ${nextId - 1n}\n`);

  const stuckContests = [];

  for (let i = 1n; i < nextId; i++) {
    try {
      const contest = await contestEscrow.getContest(i);
      const status = Number(contest[8]);
      const statusNames = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];

      console.log(`Contest #${i}: ${statusNames[status] || status}`);

      if (status === 1) {
        stuckContests.push(Number(i));
      }
    } catch (e) {
      console.log(`Contest #${i}: Error - ${e.message}`);
    }
  }

  console.log(`\n🔴 Stuck contests (PendingVRF): ${stuckContests.join(', ') || 'None'}`);

  if (stuckContests.length === 0) {
    console.log('✅ No stuck contests to cancel!');
    return;
  }

  // Try to cancel each stuck contest
  for (const contestId of stuckContests) {
    console.log(`\n🗑️ Attempting to cancel Contest #${contestId}...`);

    // Try different cancel functions
    const cancelFunctions = [
      { name: 'emergencyCancel', fn: () => contestEscrow.emergencyCancel(contestId) },
      { name: 'forceCancel', fn: () => contestEscrow.forceCancel(contestId) },
      { name: 'adminCancel', fn: () => contestEscrow.adminCancel(contestId) },
      { name: 'cancelContest', fn: () => contestEscrow.cancelContest(contestId, 'VRF stuck - manual cancel') },
    ];

    for (const { name, fn } of cancelFunctions) {
      try {
        console.log(`   Trying ${name}...`);
        const tx = await fn();
        console.log(`   ✅ TX submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`   ✅ Cancelled in block ${receipt.blockNumber}`);
        break; // Success, move to next contest
      } catch (e) {
        const reason = e.reason || e.message;
        if (reason.includes('not a function') || reason.includes('cannot estimate gas')) {
          console.log(`   ❌ ${name} - function not available`);
        } else {
          console.log(`   ❌ ${name} - ${reason.slice(0, 80)}`);
        }
      }
    }
  }

  console.log('\n✅ Done!');
}

main().catch(console.error);
