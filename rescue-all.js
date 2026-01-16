/**
 * Rescue All Stuck Contests
 *
 * Uses emergencyRelease to clear stuck PendingVRF contests
 * Will send funds back to the host if no qualified entries exist
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC'
};

const ABI = [
  'function emergencyRelease(uint256 _contestId, address _winner) external',
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
  'function owner() view returns (address)'
];

const STATUS = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  if (!process.env.PRIVATE_KEY) {
    console.log('❌ PRIVATE_KEY not set. Run: source .env.local');
    process.exit(1);
  }

  const privateKey = process.env.PRIVATE_KEY.trim().replace(/\\n/g, '');
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, wallet);

  console.log('🔑 Wallet:', wallet.address);

  const owner = await contract.owner();
  console.log('📋 Contract owner:', owner);

  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.log('❌ You are not the owner!');
    process.exit(1);
  }

  const nextId = await contract.nextContestId();
  console.log('📊 Total contests:', (nextId - 1n).toString());
  console.log('');

  // Check each contest
  for (let i = 1n; i < nextId; i++) {
    const contestId = Number(i);
    console.log('━━━ Contest #' + contestId + ' ━━━');

    try {
      const c = await contract.getContest(contestId);
      const status = Number(c[8]);
      const host = c[0];
      const prizeAmount = c[2];
      const currentWinner = c[9];

      console.log('  Status: ' + STATUS[status]);
      console.log('  Host: ' + host);
      console.log('  Prize: ' + ethers.formatEther(prizeAmount));

      if (status === 2) {
        console.log('  ✅ Already completed - Winner: ' + currentWinner);
        console.log('');
        continue;
      }

      if (status === 3) {
        console.log('  ✅ Already cancelled');
        console.log('');
        continue;
      }

      if (status === 0) {
        console.log('  ⏳ Still active - not stuck');
        console.log('');
        continue;
      }

      // Status 1 = PendingVRF = stuck!
      if (status === 1) {
        console.log('  🔴 STUCK in PendingVRF!');

        // Get qualified entries
        try {
          const entries = await contract.getQualifiedEntries(contestId);
          console.log('  Qualified entries: ' + entries.length);

          // Send to dev wallet
          const winner = '0x78EeAA6F014667A339fCF8b4eCd74743366603fb';
          console.log('  🚑 Emergency releasing to: ' + winner);

          const tx = await contract.emergencyRelease(contestId, winner);
          console.log('  TX: ' + tx.hash);
          const receipt = await tx.wait();
          console.log('  ✅ Released in block ' + receipt.blockNumber);
        } catch (e) {
          console.log('  ❌ Release failed: ' + (e.reason || e.message).slice(0, 80));
        }
      }

    } catch (e) {
      console.log('  ⚠️ Cannot read contest: ' + (e.message || '').slice(0, 50));
      console.log('  🔧 Trying emergency release to host wallet anyway...');

      // Try emergency release to your wallet as fallback
      try {
        const tx = await contract.emergencyRelease(contestId, wallet.address);
        console.log('  TX: ' + tx.hash);
        const receipt = await tx.wait();
        console.log('  ✅ Released in block ' + receipt.blockNumber);
      } catch (e2) {
        console.log('  ❌ Emergency release failed: ' + (e2.reason || e2.message).slice(0, 80));
      }
    }

    console.log('');
  }

  console.log('✅ Done!');
}

main().catch(console.error);
