/**
 * Winner Announcement API
 *
 * This endpoint checks for completed contests and posts winner announcements
 * as replies to the original cast.
 *
 * Flow:
 * 1. Check for contests in "Completed" status that haven't been announced
 * 2. Get winner address from contract
 * 3. Look up winner's Farcaster username via their wallet
 * 4. Post reply to original cast with winner announcement
 *
 * Usage:
 *   POST /api/announce-winner (cron - checks all completed contests)
 *   GET /api/announce-winner?contestId=7 (announce specific contest)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
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

// Track announced contests (in production, use a database)
// For now, we'll check if a cast reply already exists
const announcedContests = new Set();

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Get Farcaster user by wallet address
 */
async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/by_verification?address=${walletAddress}`,
      {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      }
    );

    if (!response.ok) {
      console.log(`   No Farcaster user found for ${walletAddress}`);
      return null;
    }

    const data = await response.json();
    return data.user || null;
  } catch (error) {
    console.error('Error fetching user by wallet:', error);
    return null;
  }
}

/**
 * Post a cast as a reply to the original contest cast
 */
async function postWinnerAnnouncement(parentCastHash, message, signerUuid) {
  try {
    // Need a signer UUID to post casts - this should be set up in Neynar dashboard
    if (!signerUuid) {
      console.log('   ⚠️ No NEYNAR_SIGNER_UUID configured - cannot post cast');
      return { success: false, error: 'No signer configured' };
    }

    const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': CONFIG.NEYNAR_API_KEY
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        text: message,
        parent: parentCastHash
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   Failed to post cast:', errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    console.log('   ✅ Winner announcement posted!');
    return { success: true, castHash: data.cast?.hash };
  } catch (error) {
    console.error('Error posting cast:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get stored custom message for a contest
 */
async function getCustomMessage(contestId) {
  try {
    // Try to fetch from the store-message API
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const response = await fetch(`${baseUrl}/api/store-message?contestId=${contestId}`);

    if (response.ok) {
      const data = await response.json();
      return data.message || null;
    }
  } catch (e) {
    console.log('   Could not fetch custom message:', e.message);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ANNOUNCEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Announce winner for a specific contest
 */
async function announceWinner(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  // Get contest details
  const contest = await contestEscrow.getContest(contestId);
  const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 2n) {
    return {
      success: false,
      error: `Contest not completed (status: ${status})`,
      contestId
    };
  }

  if (winner === '0x0000000000000000000000000000000000000000') {
    return {
      success: false,
      error: 'No winner set',
      contestId
    };
  }

  // Check if already announced
  if (announcedContests.has(contestId)) {
    return {
      success: false,
      error: 'Already announced',
      contestId
    };
  }

  console.log(`\n🎉 Announcing winner for Contest #${contestId}`);
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

  // Get custom message (if stored)
  const customMessage = await getCustomMessage(contestId);

  // Build announcement message
  let announcement = `🎉 CONTEST COMPLETE!\n\n`;

  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }

  announcement += `🏆 Winner: ${winnerTag}\n`;
  announcement += `💰 Prize: ${prizeDisplay}\n`;
  announcement += `👥 Participants: ${participantCount}\n`;
  announcement += `🎲 Selected via Chainlink VRF\n\n`;
  announcement += `Congrats ${winnerDisplay}! 🦎`;

  console.log(`   Message: ${announcement.slice(0, 100)}...`);

  // Extract actual cast hash (remove requirements suffix if present)
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

  // Post the announcement
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!signerUuid) {
    console.log('   ⚠️ NEYNAR_SIGNER_UUID not set - skipping cast post');
    console.log('   Would have posted:', announcement);

    // Mark as announced anyway (for dry run)
    announcedContests.add(contestId);

    return {
      success: true,
      contestId,
      winner,
      winnerUsername: winnerUser?.username,
      prize: prizeDisplay,
      participants: participantCount,
      message: announcement,
      posted: false,
      note: 'Set NEYNAR_SIGNER_UUID to enable automatic cast posting'
    };
  }

  const postResult = await postWinnerAnnouncement(actualCastHash, announcement, signerUuid);

  if (postResult.success) {
    announcedContests.add(contestId);
  }

  return {
    success: postResult.success,
    contestId,
    winner,
    winnerUsername: winnerUser?.username,
    prize: prizeDisplay,
    participants: participantCount,
    message: announcement,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

/**
 * Check all contests and announce any completed ones
 */
async function checkAndAnnounceAll() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const nextContestId = await contestEscrow.nextContestId();
  const results = [];

  console.log(`\n🔍 Checking contests 1 to ${nextContestId - 1n} for announcements...`);

  for (let i = 1n; i < nextContestId; i++) {
    try {
      const contest = await contestEscrow.getContest(i);
      const status = contest[8];
      const winner = contest[9];

      // Only announce completed contests with winners
      if (status === 2n && winner !== '0x0000000000000000000000000000000000000000') {
        if (!announcedContests.has(Number(i))) {
          const result = await announceWinner(Number(i));
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

  try {
    // GET: Announce specific contest
    if (req.method === 'GET') {
      const contestId = parseInt(req.query.contestId);

      if (!contestId || isNaN(contestId)) {
        return res.status(400).json({
          error: 'Missing or invalid contestId parameter'
        });
      }

      const result = await announceWinner(contestId);
      return res.status(result.success ? 200 : 400).json(result);
    }

    // POST: Check all contests (for cron)
    if (req.method === 'POST') {
      const results = await checkAndAnnounceAll();
      return res.status(200).json({
        checked: results.length,
        results
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      error: error.message
    });
  }
};

// For local testing
if (require.main === module) {
  const contestId = process.argv[2];

  if (contestId) {
    announceWinner(parseInt(contestId))
      .then(result => {
        console.log('\n📊 Result:', JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      });
  } else {
    checkAndAnnounceAll()
      .then(results => {
        console.log('\n📊 Results:', JSON.stringify(results, null, 2));
        process.exit(0);
      });
  }
}
