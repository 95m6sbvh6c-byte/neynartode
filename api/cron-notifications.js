/**
 * Cron Notifications API
 *
 * Called by Vercel Cron to check for:
 * - Contests ending in 1 hour (send reminder)
 * - New #1 on leaderboard
 *
 * Vercel Cron Config (add to vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/cron-notifications",
 *     "schedule": "0 * * * *"  // Every hour
 *   }]
 * }
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://rpc.ankr.com/base',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const ERC721_ABI = [
  'function name() view returns (string)',
];

/**
 * Get user info by wallet
 */
async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress.toLowerCase()}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    const users = data[walletAddress.toLowerCase()];

    if (users && users.length > 0) {
      return {
        fid: users[0].fid,
        username: users[0].username,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Get token symbol
 */
async function getTokenSymbol(provider, tokenAddress) {
  if (tokenAddress === '0x0000000000000000000000000000000000000000') {
    return 'ETH';
  }
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await token.symbol();
  } catch (e) {
    return 'TOKENS';
  }
}

/**
 * Check if we already sent ending-soon notification for this contest
 */
async function hasNotifiedEndingSoon(contestId, isNft) {
  if (!process.env.KV_REST_API_URL) return false;

  try {
    const { kv } = await import('@vercel/kv');
    const key = isNft ? `notif:ending:nft:${contestId}` : `notif:ending:${contestId}`;
    return await kv.exists(key);
  } catch (e) {
    return false;
  }
}

/**
 * Mark contest as notified for ending-soon
 */
async function markNotifiedEndingSoon(contestId, isNft) {
  if (!process.env.KV_REST_API_URL) return;

  try {
    const { kv } = await import('@vercel/kv');
    const key = isNft ? `notif:ending:nft:${contestId}` : `notif:ending:${contestId}`;
    // Expire after 24 hours
    await kv.set(key, true, { ex: 86400 });
  } catch (e) {
    console.error('Error marking notified:', e.message);
  }
}

/**
 * Check contests ending in ~1 hour
 */
async function checkContestsEndingSoon(provider) {
  const contestsEndingSoon = [];
  const now = Math.floor(Date.now() / 1000);
  const oneHour = 3600;

  // Check token contests
  const tokenContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
  const tokenNextId = await tokenContract.nextContestId();
  const totalTokenContests = Number(tokenNextId) - 1;

  for (let i = totalTokenContests; i >= Math.max(1, totalTokenContests - 20); i--) {
    try {
      const contest = await tokenContract.getContest(i);
      const [host, prizeToken, prizeAmount, , endTime, , , , status] = contest;

      const contestEndTime = Number(endTime);
      const contestStatus = Number(status);

      // Check if contest is active and ends in 45-75 minutes (to catch hourly cron)
      if (contestStatus === 0 && contestEndTime > now && contestEndTime <= now + oneHour + 900) {
        // Check if we already notified
        if (await hasNotifiedEndingSoon(i, false)) continue;

        const hostUser = await getUserByWallet(host);
        const symbol = await getTokenSymbol(provider, prizeToken);
        const decimals = prizeToken === '0x0000000000000000000000000000000000000000' ? 18 : 18;
        const amount = Number(prizeAmount) / Math.pow(10, decimals);

        contestsEndingSoon.push({
          contestId: i,
          isNft: false,
          prize: `${amount.toLocaleString()} ${symbol}`,
          hostUsername: hostUser?.username,
          endTime: contestEndTime,
        });
      }
    } catch (e) {
      // Skip errored contests
    }
  }

  // Check NFT contests
  const nftContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
  try {
    const nftNextId = await nftContract.nextContestId();
    const totalNftContests = Number(nftNextId) - 1;

    for (let i = totalNftContests; i >= Math.max(1, totalNftContests - 10); i--) {
      try {
        const contest = await nftContract.getContest(i);
        const [host, , nftContractAddr, tokenId, , , endTime, , , , status] = contest;

        const contestEndTime = Number(endTime);
        const contestStatus = Number(status);

        if (contestStatus === 0 && contestEndTime > now && contestEndTime <= now + oneHour + 900) {
          if (await hasNotifiedEndingSoon(i, true)) continue;

          const hostUser = await getUserByWallet(host);

          // Try to get NFT collection name
          let nftName = 'NFT';
          try {
            const nftTokenContract = new ethers.Contract(nftContractAddr, ERC721_ABI, provider);
            nftName = await nftTokenContract.name();
          } catch (e) {
            // Fallback to generic
          }

          contestsEndingSoon.push({
            contestId: i,
            isNft: true,
            prize: `${nftName} #${Number(tokenId)}`,
            hostUsername: hostUser?.username,
            endTime: contestEndTime,
          });
        }
      } catch (e) {
        // Skip errored contests
      }
    }
  } catch (e) {
    // NFT contract might not exist
  }

  return contestsEndingSoon;
}

module.exports = async (req, res) => {
  // Verify cron secret (Vercel sets this automatically for cron jobs)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow manual calls with notification secret
    const notifSecret = process.env.NOTIFICATION_SECRET || 'neynartodes-notif-secret';
    if (authHeader !== `Bearer ${notifSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Import sendNotification
    const { sendNotification } = require('./send-notification');

    // Check for contests ending soon
    console.log('Checking for contests ending soon...');
    const endingSoon = await checkContestsEndingSoon(provider);

    let notificationsSent = 0;

    for (const contest of endingSoon) {
      console.log(`Contest ${contest.isNft ? 'NFT-' : ''}${contest.contestId} ending soon, sending notification...`);

      await sendNotification('contest_ending_soon', {
        contestId: contest.contestId,
        prize: contest.prize,
        hostUsername: contest.hostUsername,
      });

      await markNotifiedEndingSoon(contest.contestId, contest.isNft);
      notificationsSent++;
    }

    return res.status(200).json({
      success: true,
      contestsEndingSoon: endingSoon.length,
      notificationsSent,
    });

  } catch (error) {
    console.error('Cron notification error:', error);
    return res.status(500).json({ error: error.message });
  }
};
