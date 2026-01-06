/**
 * Periodic Cron - Light Backfill + Daily Notification
 *
 * Runs every 30 minutes to:
 * 1. Backfill any recently completed contests that might have been missed in the season index
 * 2. Send daily notification about active contests (only at midnight UTC)
 *
 * Vercel Cron Config (add to vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/cron-daily",
 *     "schedule": "*/30 * * * *"  // Every 30 minutes
 *   }]
 * }
 */

const { ethers } = require('ethers');

const CONFIG = {
  // V1 Contracts (legacy - read-only)
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  // V2 Contract (legacy - read-only)
  CONTEST_MANAGER_V2: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06',
  V2_START_ID: 105,
  // NEW Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  // How many recent contests to check per type
  BACKFILL_TOKEN_COUNT: 30,
  BACKFILL_NFT_COUNT: 10,
  BACKFILL_V2_COUNT: 50,
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
  'function nextContestId() external view returns (uint256)',
];

const PRIZE_NFT_ABI = [
  'function seasons(uint256) external view returns (string theme, uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
];

/**
 * Count active contests (status = 0 and not ended)
 */
async function countActiveContests(provider) {
  const now = Math.floor(Date.now() / 1000);
  let activeCount = 0;

  // Count token contests
  try {
    const tokenContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const tokenNextId = await tokenContract.nextContestId();
    const totalTokenContests = Number(tokenNextId) - 1;

    for (let i = totalTokenContests; i >= Math.max(1, totalTokenContests - 50); i--) {
      try {
        const contest = await tokenContract.getContest(i);
        const [, , , , endTime, , , , status] = contest;

        const contestEndTime = Number(endTime);
        const contestStatus = Number(status);

        // Status 0 = Active, and not ended yet
        if (contestStatus === 0 && contestEndTime > now) {
          activeCount++;
        }
      } catch (e) {
        // Skip errored contests
      }
    }
  } catch (e) {
    console.error('Error counting token contests:', e.message);
  }

  // Count NFT contests
  try {
    const nftContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const nftNextId = await nftContract.nextContestId();
    const totalNftContests = Number(nftNextId) - 1;

    for (let i = totalNftContests; i >= Math.max(1, totalNftContests - 20); i--) {
      try {
        const contest = await nftContract.getContest(i);
        const [, , , , , , endTime, , , , status] = contest;

        const contestEndTime = Number(endTime);
        const contestStatus = Number(status);

        if (contestStatus === 0 && contestEndTime > now) {
          activeCount++;
        }
      } catch (e) {
        // Skip errored contests
      }
    }
  } catch (e) {
    console.error('Error counting NFT contests:', e.message);
  }

  return activeCount;
}

/**
 * Fetch cast engagement from Neynar API
 */
async function getCastEngagement(castHash) {
  try {
    const castResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${castHash}&type=hash`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!castResponse.ok) {
      return { error: `Cast fetch failed: ${castResponse.status}` };
    }

    const castData = await castResponse.json();
    const cast = castData.cast;

    if (!cast) {
      return { error: 'Cast not found' };
    }

    return {
      likes: cast.reactions?.likes_count || 0,
      recasts: cast.reactions?.recasts_count || 0,
      replies: cast.replies?.count || 0,
      castHash: cast.hash,
      hostFid: cast.author?.fid || null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Light backfill - only checks recent contests and adds missing ones to season index
 * Much faster than full backfill, designed to run daily
 */
async function lightBackfill(provider, kv) {
  const results = { added: [], skipped: [], errors: [] };

  // Get current season (hardcoded to 2 for now, could be dynamic)
  const seasonId = 2;

  try {
    // Get season time range
    const prizeNFTContract = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
    const season = await prizeNFTContract.seasons(seasonId);
    const seasonStartTime = Number(season.startTime);
    const seasonEndTime = Number(season.endTime);

    if (seasonStartTime === 0) {
      console.log('Season not found, skipping backfill');
      return results;
    }

    // Get current season index contents
    const indexKey = `season:${seasonId}:contests`;
    const existingKeys = new Set(await kv.zrange(indexKey, 0, -1) || []);
    console.log(`Season index has ${existingKeys.size} contests`);

    // Initialize contracts
    const contestEscrow = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContestEscrow = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER_V2, CONTEST_MANAGER_V2_ABI, provider);

    // Get next contest IDs
    const nextTokenId = Number(await contestEscrow.nextContestId());
    const nextNftId = Number(await nftContestEscrow.nextContestId());
    const nextV2Id = Number(await contestManager.nextContestId());

    // Check recent V1 Token contests
    const tokenStart = Math.max(1, nextTokenId - CONFIG.BACKFILL_TOKEN_COUNT);
    for (let id = tokenStart; id < nextTokenId; id++) {
      const contestKey = `token-${id}`;
      if (existingKeys.has(contestKey)) continue;

      try {
        const contest = await contestEscrow.getContest(id);
        const [host, , , , endTime, castId, , , status] = contest;
        const contestEndTime = Number(endTime);

        // Only add completed/cancelled contests within season window
        if (status !== 2n && status !== 3n) continue;
        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) continue;

        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        // Fetch social data and store
        const socialData = await getCastEngagement(actualCastHash);
        const cacheData = {
          likes: socialData.likes || 0,
          recasts: socialData.recasts || 0,
          replies: socialData.replies || 0,
          castHash: actualCastHash,
          hostFid: socialData.hostFid || null,
          host,
          status: Number(status),
          capturedAt: Date.now(),
          backfilled: true,
        };

        await kv.set(`contest:social:${contestKey}`, cacheData);
        await kv.zadd(indexKey, { score: contestEndTime, member: contestKey });

        results.added.push({ type: 'token', id, status: Number(status) });
        console.log(`  Added missing token-${id} to season index`);
      } catch (e) {
        results.errors.push({ type: 'token', id, error: e.message });
      }
    }

    // Check recent V1 NFT contests
    const nftStart = Math.max(1, nextNftId - CONFIG.BACKFILL_NFT_COUNT);
    for (let id = nftStart; id < nextNftId; id++) {
      const contestKey = `nft-${id}`;
      if (existingKeys.has(contestKey)) continue;

      try {
        const contest = await nftContestEscrow.getContest(id);
        const [host, , , , , , endTime, castId, , , status] = contest;
        const contestEndTime = Number(endTime);

        if (status !== 2n && status !== 3n) continue;
        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) continue;

        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        const socialData = await getCastEngagement(actualCastHash);
        const cacheData = {
          likes: socialData.likes || 0,
          recasts: socialData.recasts || 0,
          replies: socialData.replies || 0,
          castHash: actualCastHash,
          hostFid: socialData.hostFid || null,
          host,
          status: Number(status),
          capturedAt: Date.now(),
          backfilled: true,
        };

        await kv.set(`contest:social:${contestKey}`, cacheData);
        await kv.zadd(indexKey, { score: contestEndTime, member: contestKey });

        results.added.push({ type: 'nft', id, status: Number(status) });
        console.log(`  Added missing nft-${id} to season index`);
      } catch (e) {
        results.errors.push({ type: 'nft', id, error: e.message });
      }
    }

    // Check recent V2 contests
    const v2Start = Math.max(CONFIG.V2_START_ID, nextV2Id - CONFIG.BACKFILL_V2_COUNT);
    for (let id = v2Start; id < nextV2Id; id++) {
      const contestKey = `v2-${id}`;
      if (existingKeys.has(contestKey)) continue;

      try {
        const contest = await contestManager.getContest(id);
        const [host, , status, castId, endTime] = contest;
        const contestEndTime = Number(endTime);

        if (status !== 2n && status !== 3n) continue;
        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) continue;

        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        const socialData = await getCastEngagement(actualCastHash);
        const cacheData = {
          likes: socialData.likes || 0,
          recasts: socialData.recasts || 0,
          replies: socialData.replies || 0,
          castHash: actualCastHash,
          hostFid: socialData.hostFid || null,
          host,
          status: Number(status),
          capturedAt: Date.now(),
          backfilled: true,
        };

        await kv.set(`contest:social:${contestKey}`, cacheData);
        await kv.zadd(indexKey, { score: contestEndTime, member: contestKey });

        results.added.push({ type: 'v2', id, status: Number(status) });
        console.log(`  Added missing v2-${id} to season index`);
      } catch (e) {
        results.errors.push({ type: 'v2', id, error: e.message });
      }
    }

    // Clear leaderboard cache if we added any contests
    if (results.added.length > 0) {
      console.log(`Clearing leaderboard cache (added ${results.added.length} contests)`);
      await kv.del(`leaderboard:s${seasonId}:l10`);
      await kv.del(`leaderboard:s${seasonId}:l25`);
      await kv.del(`leaderboard:s${seasonId}:l50`);
    }

  } catch (e) {
    console.error('Light backfill error:', e.message);
    results.errors.push({ type: 'general', error: e.message });
  }

  return results;
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

    // Count active contests
    console.log('Counting active contests...');
    const activeCount = await countActiveContests(provider);
    console.log(`Found ${activeCount} active contests`);

    // Run light backfill to catch any missed completed contests
    console.log('Running light backfill...');
    let backfillResults = { added: [], errors: [] };
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      backfillResults = await lightBackfill(provider, kv);
      console.log(`Backfill complete: added ${backfillResults.added.length}, errors ${backfillResults.errors.length}`);
    } else {
      console.log('KV not configured, skipping backfill');
    }

    // Import sendNotification
    const { sendNotification } = require('./send-notification');

    // Send daily notification
    const result = await sendNotification('daily_active_contests', {
      count: activeCount,
    });

    return res.status(200).json({
      success: true,
      activeContests: activeCount,
      notificationsSent: result.sent,
      backfill: {
        contestsAdded: backfillResults.added.length,
        added: backfillResults.added,
        errors: backfillResults.errors,
      },
    });

  } catch (error) {
    console.error('Daily cron error:', error);
    return res.status(500).json({ error: error.message });
  }
};
