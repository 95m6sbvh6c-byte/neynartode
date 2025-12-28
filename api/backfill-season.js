/**
 * Backfill Season API
 *
 * Populates the season cache with existing finalized contests.
 * This is used to backfill Season 2 data so the leaderboard can read from cache.
 *
 * POST /api/backfill-season
 * Body: { seasonId: 2 }
 *
 * Requires PRIVATE_KEY environment variable for admin auth.
 */

const { ethers } = require('ethers');

const CONFIG = {
  // Contract addresses
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  CONTEST_MANAGER_V2: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  V2_START_ID: 105,

  // RPC & API
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',

  // Rate limiting
  API_DELAY_MS: 100,
};

// Contract ABIs
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
 * Fetch cast engagement from Neynar API
 */
async function getCastEngagement(castHash) {
  try {
    // Fetch cast details
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
 * Store social data in KV
 */
async function storeSocialData(kv, contestType, contestId, socialData) {
  const cacheKey = `contest:social:${contestType}-${contestId}`;

  const cacheData = {
    likes: socialData.likes || 0,
    recasts: socialData.recasts || 0,
    replies: socialData.replies || 0,
    castHash: socialData.castHash || null,
    hostFid: socialData.hostFid || null,
    capturedAt: Date.now(),
    backfilled: true, // Mark as backfilled vs captured at finalization
  };

  await kv.set(cacheKey, cacheData);
  return cacheKey;
}

/**
 * Add contest to season index
 */
async function addToSeasonIndex(kv, seasonId, contestType, contestId, endTime) {
  const indexKey = `season:${seasonId}:contests`;
  const contestKey = `${contestType}-${contestId}`;

  await kv.zadd(indexKey, { score: endTime, member: contestKey });
  return contestKey;
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Check current KV storage state
  if (req.method === 'GET') {
    if (!process.env.KV_REST_API_URL) {
      return res.status(500).json({ error: 'KV storage not configured' });
    }

    const seasonId = parseInt(req.query.season) || 2;

    try {
      const { kv } = require('@vercel/kv');

      // Get all contests in the season index
      const indexKey = `season:${seasonId}:contests`;
      const contestKeys = await kv.zrange(indexKey, 0, -1) || [];

      // Group by type
      const tokenContests = contestKeys.filter(k => k.startsWith('token-')).map(k => parseInt(k.split('-')[1]));
      const nftContests = contestKeys.filter(k => k.startsWith('nft-')).map(k => parseInt(k.split('-')[1]));
      const v2Contests = contestKeys.filter(k => k.startsWith('v2-')).map(k => parseInt(k.split('-')[1]));

      // Sample some social data to verify
      const sampleKeys = contestKeys.slice(0, 5);
      const sampleData = await Promise.all(
        sampleKeys.map(async (key) => {
          const socialKey = `contest:social:${key}`;
          const data = await kv.get(socialKey).catch(() => null);
          return { key, socialKey, hasData: !!data, data: data ? { likes: data.likes, recasts: data.recasts, replies: data.replies } : null };
        })
      );

      return res.status(200).json({
        seasonId,
        indexKey,
        totalContests: contestKeys.length,
        breakdown: {
          token: tokenContests.length,
          nft: nftContests.length,
          v2: v2Contests.length,
        },
        contestIds: {
          token: tokenContests.sort((a, b) => a - b),
          nft: nftContests.sort((a, b) => a - b),
          v2: v2Contests.sort((a, b) => a - b),
        },
        sampleSocialData: sampleData,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Admin auth check
  if (!process.env.PRIVATE_KEY) {
    return res.status(500).json({ error: 'PRIVATE_KEY not configured' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { seasonId = 2, dryRun = false } = req.body || {};

  console.log(`\n${'='.repeat(60)}`);
  console.log(`BACKFILL SEASON ${seasonId}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    const { kv } = require('@vercel/kv');
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Get season time range
    const prizeNFTContract = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
    const season = await prizeNFTContract.seasons(seasonId);
    const seasonStartTime = Number(season.startTime);
    const seasonEndTime = Number(season.endTime);

    console.log(`Season ${seasonId}: ${season.theme}`);
    console.log(`  Start: ${new Date(seasonStartTime * 1000).toISOString()}`);
    console.log(`  End: ${new Date(seasonEndTime * 1000).toISOString()}`);

    if (seasonStartTime === 0) {
      return res.status(400).json({ error: `Season ${seasonId} not found or not started` });
    }

    const results = {
      seasonId,
      seasonTheme: season.theme,
      seasonStart: new Date(seasonStartTime * 1000).toISOString(),
      seasonEnd: new Date(seasonEndTime * 1000).toISOString(),
      processed: [],
      skipped: [],
      errors: [],
    };

    // Initialize contracts
    const contestEscrow = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContestEscrow = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER_V2, CONTEST_MANAGER_V2_ABI, provider);

    // Get next contest IDs
    const nextTokenId = Number(await contestEscrow.nextContestId());
    const nextNftId = Number(await nftContestEscrow.nextContestId());
    const nextV2Id = Number(await contestManager.nextContestId());

    console.log(`\nContest ranges:`);
    console.log(`  Token (V1): 1 to ${nextTokenId - 1}`);
    console.log(`  NFT (V1): 1 to ${nextNftId - 1}`);
    console.log(`  V2: ${CONFIG.V2_START_ID} to ${nextV2Id - 1}`);

    // Process V1 Token contests
    console.log(`\n--- Processing V1 Token Contests ---`);
    for (let id = 1; id < nextTokenId; id++) {
      try {
        const contest = await contestEscrow.getContest(id);
        const [, , , , endTime, castId, , , status] = contest;
        const contestEndTime = Number(endTime);

        // Skip if not completed (status 2) or cancelled (status 3)
        if (status !== 2n && status !== 3n) {
          results.skipped.push({ type: 'token', id, reason: 'not completed' });
          continue;
        }

        // Skip if outside season window
        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
          results.skipped.push({ type: 'token', id, reason: 'outside season' });
          continue;
        }

        // Extract actual cast hash
        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        console.log(`  Token #${id}: ${actualCastHash.substring(0, 10)}...`);

        // Fetch social data
        await new Promise(r => setTimeout(r, CONFIG.API_DELAY_MS));
        const socialData = await getCastEngagement(actualCastHash);

        if (socialData.error) {
          results.errors.push({ type: 'token', id, error: socialData.error });
          console.log(`    ERROR: ${socialData.error}`);
          continue;
        }

        if (!dryRun) {
          await storeSocialData(kv, 'token', id, socialData);
          await addToSeasonIndex(kv, seasonId, 'token', id, contestEndTime);
        }

        results.processed.push({
          type: 'token',
          id,
          likes: socialData.likes,
          recasts: socialData.recasts,
          replies: socialData.replies,
        });

        console.log(`    L:${socialData.likes} R:${socialData.recasts} Re:${socialData.replies}`);
      } catch (e) {
        results.errors.push({ type: 'token', id, error: e.message });
      }
    }

    // Process V1 NFT contests
    console.log(`\n--- Processing V1 NFT Contests ---`);
    for (let id = 1; id < nextNftId; id++) {
      try {
        const contest = await nftContestEscrow.getContest(id);
        const [, , , , , , endTime, castId, , , status] = contest;
        const contestEndTime = Number(endTime);

        if (status !== 2n && status !== 3n) {
          results.skipped.push({ type: 'nft', id, reason: 'not completed' });
          continue;
        }

        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
          results.skipped.push({ type: 'nft', id, reason: 'outside season' });
          continue;
        }

        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        console.log(`  NFT #${id}: ${actualCastHash.substring(0, 10)}...`);

        await new Promise(r => setTimeout(r, CONFIG.API_DELAY_MS));
        const socialData = await getCastEngagement(actualCastHash);

        if (socialData.error) {
          results.errors.push({ type: 'nft', id, error: socialData.error });
          console.log(`    ERROR: ${socialData.error}`);
          continue;
        }

        if (!dryRun) {
          await storeSocialData(kv, 'nft', id, socialData);
          await addToSeasonIndex(kv, seasonId, 'nft', id, contestEndTime);
        }

        results.processed.push({
          type: 'nft',
          id,
          likes: socialData.likes,
          recasts: socialData.recasts,
          replies: socialData.replies,
        });

        console.log(`    L:${socialData.likes} R:${socialData.recasts} Re:${socialData.replies}`);
      } catch (e) {
        results.errors.push({ type: 'nft', id, error: e.message });
      }
    }

    // Process V2 contests
    console.log(`\n--- Processing V2 Contests ---`);
    for (let id = CONFIG.V2_START_ID; id < nextV2Id; id++) {
      try {
        const contest = await contestManager.getContest(id);
        const [, , status, castId, endTime] = contest;
        const contestEndTime = Number(endTime);

        if (status !== 2n && status !== 3n) {
          results.skipped.push({ type: 'v2', id, reason: 'not completed' });
          continue;
        }

        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
          results.skipped.push({ type: 'v2', id, reason: 'outside season' });
          continue;
        }

        const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

        console.log(`  V2 #${id}: ${actualCastHash.substring(0, 10)}...`);

        await new Promise(r => setTimeout(r, CONFIG.API_DELAY_MS));
        const socialData = await getCastEngagement(actualCastHash);

        if (socialData.error) {
          results.errors.push({ type: 'v2', id, error: socialData.error });
          console.log(`    ERROR: ${socialData.error}`);
          continue;
        }

        if (!dryRun) {
          await storeSocialData(kv, 'v2', id, socialData);
          await addToSeasonIndex(kv, seasonId, 'v2', id, contestEndTime);
        }

        results.processed.push({
          type: 'v2',
          id,
          likes: socialData.likes,
          recasts: socialData.recasts,
          replies: socialData.replies,
        });

        console.log(`    L:${socialData.likes} R:${socialData.recasts} Re:${socialData.replies}`);
      } catch (e) {
        results.errors.push({ type: 'v2', id, error: e.message });
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BACKFILL COMPLETE`);
    console.log(`  Processed: ${results.processed.length}`);
    console.log(`  Skipped: ${results.skipped.length}`);
    console.log(`  Errors: ${results.errors.length}`);
    console.log(`${'='.repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      dryRun,
      summary: {
        processed: results.processed.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
      },
      ...results,
    });

  } catch (error) {
    console.error('Backfill error:', error);
    return res.status(500).json({ error: error.message });
  }
};
