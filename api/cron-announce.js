/**
 * Cron Job: Auto-Announce Winners
 *
 * This endpoint runs on a schedule to:
 * 1. Check for completed contests with winners
 * 2. Auto-announce any that haven't been announced yet
 *
 * Vercel Cron: runs every minute
 *
 * Usage:
 *   GET /api/cron-announce (triggered by Vercel Cron)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  NEYNAR_SIGNER_UUID: process.env.NEYNAR_SIGNER_UUID,
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

// ═══════════════════════════════════════════════════════════════════
// KV STORAGE FOR TRACKING ANNOUNCED CONTESTS
// ═══════════════════════════════════════════════════════════════════

async function getAnnouncedContests() {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const announced = await kv.get('announced_contests');
      return announced ? new Set(announced) : new Set();
    }
  } catch (e) {
    console.log('KV not available for announced tracking');
  }
  return new Set();
}

async function markContestAnnounced(contestId) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const announced = await kv.get('announced_contests') || [];
      if (!announced.includes(contestId)) {
        announced.push(contestId);
        await kv.set('announced_contests', announced);
      }
    }
  } catch (e) {
    console.log('Could not persist announced status:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    // Response format: { [address]: [users] }
    const users = data[walletAddress.toLowerCase()];
    return users?.[0] || null;
  } catch (error) {
    console.error('Error fetching user by wallet:', error);
    return null;
  }
}

async function postWinnerAnnouncement(parentCastHash, message) {
  if (!CONFIG.NEYNAR_SIGNER_UUID) {
    console.log('⚠️ No NEYNAR_SIGNER_UUID - cannot post');
    return { success: false, error: 'No signer configured' };
  }

  try {
    const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': CONFIG.NEYNAR_API_KEY
      },
      body: JSON.stringify({
        signer_uuid: CONFIG.NEYNAR_SIGNER_UUID,
        text: message,
        parent: parentCastHash
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to post cast:', errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    return { success: true, castHash: data.cast?.hash };
  } catch (error) {
    console.error('Error posting cast:', error);
    return { success: false, error: error.message };
  }
}

async function getCustomMessage(contestId) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      return await kv.get(`contest_message_${contestId}`);
    }
  } catch (e) {
    console.log('Could not fetch custom message');
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ANNOUNCEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════

async function announceWinner(contestId, announcedSet) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const contest = await contestEscrow.getContest(contestId);
  const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 2n) {
    return { skip: true, reason: `Not completed (status: ${status})` };
  }

  if (winner === '0x0000000000000000000000000000000000000000') {
    return { skip: true, reason: 'No winner set' };
  }

  if (announcedSet.has(contestId)) {
    return { skip: true, reason: 'Already announced' };
  }

  console.log(`\n🎉 Announcing Contest #${contestId}`);
  console.log(`   Winner: ${winner}`);

  // Get winner's Farcaster profile
  const winnerUser = await getUserByWallet(winner);
  const winnerTag = winnerUser ? `@${winnerUser.username}` : winner.slice(0, 10) + '...';
  const winnerDisplay = winnerUser ? winnerUser.display_name || winnerUser.username : 'Winner';

  // Get prize info
  let prizeDisplay = '';
  if (prizeToken === '0x0000000000000000000000000000000000000000') {
    prizeDisplay = `${ethers.formatEther(prizeAmount)} ETH`;
  } else {
    try {
      const tokenContract = new ethers.Contract(prizeToken, ERC20_ABI, provider);
      const symbol = await tokenContract.symbol();
      const decimals = await tokenContract.decimals();
      const amount = Number(prizeAmount) / Math.pow(10, Number(decimals));
      prizeDisplay = `${amount.toLocaleString()} $${symbol}`;
    } catch (e) {
      prizeDisplay = `${ethers.formatEther(prizeAmount)} tokens`;
    }
  }

  // Get qualified entries count
  const qualifiedEntries = await contestEscrow.getQualifiedEntries(contestId);
  const participantCount = qualifiedEntries.length;

  // Get custom message
  const customMessage = await getCustomMessage(contestId);

  // Build announcement
  let announcement = `🎉 CONTEST COMPLETE!\n\n`;
  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }
  announcement += `🏆 Winner: ${winnerTag}\n`;
  announcement += `💰 Prize: ${prizeDisplay}\n`;
  announcement += `👥 Participants: ${participantCount}\n`;
  announcement += `🎲 Selected via Chainlink VRF\n\n`;
  announcement += `Congrats ${winnerDisplay}! 🦎`;

  // Extract actual cast hash
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

  // Post announcement
  const postResult = await postWinnerAnnouncement(actualCastHash, announcement);

  if (postResult.success) {
    await markContestAnnounced(contestId);
  }

  return {
    success: postResult.success,
    contestId,
    winner,
    winnerUsername: winnerUser?.username,
    prize: prizeDisplay,
    participants: participantCount,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

async function checkAndAnnounceAll() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const nextContestId = await contestEscrow.nextContestId();
  const announcedSet = await getAnnouncedContests();
  const results = [];

  console.log(`\n🔍 Checking contests 1 to ${nextContestId - 1n} for announcements...`);
  console.log(`   Already announced: ${announcedSet.size} contests`);

  for (let i = 1n; i < nextContestId; i++) {
    const contestId = Number(i);

    // Skip if already announced
    if (announcedSet.has(contestId)) {
      continue;
    }

    try {
      const contest = await contestEscrow.getContest(i);
      const status = contest[8];
      const winner = contest[9];

      // Only announce completed contests with winners
      if (status === 2n && winner !== '0x0000000000000000000000000000000000000000') {
        const result = await announceWinner(contestId, announcedSet);
        if (!result.skip) {
          results.push(result);
        }
      }
    } catch (e) {
      console.log(`   Contest #${i} error:`, e.message?.slice(0, 50));
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// VERCEL API HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Verify cron secret if configured (optional but recommended)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    // Allow manual calls without secret for testing
    if (req.query.manual !== 'true') {
      console.log('⚠️ No cron secret provided, allowing anyway for now');
    }
  }

  try {
    const results = await checkAndAnnounceAll();

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      announced: results.length,
      results
    });

  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
