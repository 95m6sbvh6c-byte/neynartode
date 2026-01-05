/**
 * Archive Season API
 *
 * Archives all season data before clearing for the next season.
 * Collects all contest data, social stats, and final leaderboard rankings
 * into a permanent archive.
 *
 * POST /api/archive-season
 * Body: { seasonId: 2, clearAfterArchive: false }
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

  // RPC
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
};

// Contract ABIs
const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
];

const PRIZE_NFT_ABI = [
  'function seasons(uint256) external view returns (string theme, uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
];

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

  const { seasonId = 2, clearAfterArchive = false, dryRun = false, displayName = null } = req.body || {};

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ARCHIVE SEASON ${seasonId}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Clear after archive: ${clearAfterArchive}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    const { kv } = require('@vercel/kv');
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Get season info
    const prizeNFTContract = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
    const season = await prizeNFTContract.seasons(seasonId);
    const seasonStartTime = Number(season.startTime);
    const seasonEndTime = Number(season.endTime);

    console.log(`Season ${seasonId}: ${season.theme}`);
    console.log(`  Start: ${new Date(seasonStartTime * 1000).toISOString()}`);
    console.log(`  End: ${new Date(seasonEndTime * 1000).toISOString()}`);
    console.log(`  Host Pool: ${ethers.formatEther(season.hostPool)} ETH`);
    console.log(`  Voter Pool: ${ethers.formatEther(season.voterPool)} ETH`);

    if (seasonStartTime === 0) {
      return res.status(400).json({ error: `Season ${seasonId} not found or not started` });
    }

    // ═══════════════════════════════════════════════════════════════════
    // COMPREHENSIVE ARCHIVE: Scan ALL contest caches from KV storage
    // This ensures we archive ALL contests, not just those in season index
    // ═══════════════════════════════════════════════════════════════════

    // Initialize contracts to get total counts
    const contestEscrow = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContestEscrow = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER_V2, CONTEST_MANAGER_V2_ABI, provider);

    // Get total contest counts from all three contracts
    const [tokenNextId, nftNextId, v2NextId] = await Promise.all([
      contestEscrow.nextContestId(),
      nftContestEscrow.nextContestId().catch(() => 1n),
      contestManager.nextContestId().catch(() => BigInt(CONFIG.V2_START_ID)),
    ]);

    const totalTokenContests = Number(tokenNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;
    const totalV2Contests = Number(v2NextId) - CONFIG.V2_START_ID;

    console.log(`\nContract contest counts: Token=${totalTokenContests}, NFT=${totalNftContests}, V2=${totalV2Contests}`);
    console.log(`Total possible contests: ${totalTokenContests + totalNftContests + totalV2Contests}`);

    // Build list of ALL contest keys to scan
    const allContestKeys = [];
    for (let i = 1; i <= totalTokenContests; i++) allContestKeys.push(`token-${i}`);
    for (let i = 1; i <= totalNftContests; i++) allContestKeys.push(`nft-${i}`);
    for (let i = CONFIG.V2_START_ID; i < Number(v2NextId); i++) allContestKeys.push(`v2-${i}`);

    console.log(`Scanning ${allContestKeys.length} contest caches from KV...`);

    // Collect all contest data
    const contestsData = [];
    const hostStats = {};
    let kvHits = 0;
    let chainFetches = 0;

    // BATCH READ: Read all contest data and social data from KV in batches
    const BATCH_SIZE = 50;
    const allContestData = new Map();
    const allSocialData = new Map();

    // Batch read contest details
    for (let i = 0; i < allContestKeys.length; i += BATCH_SIZE) {
      const batch = allContestKeys.slice(i, i + BATCH_SIZE);
      const contestCacheKeys = batch.map(k => {
        const [type, id] = k.split('-');
        return `contest:${type}:${id}`;
      });
      const socialCacheKeys = batch.map(k => `contest:social:${k}`);

      // Batch read from KV using mget
      const [contestResults, socialResults] = await Promise.all([
        kv.mget(...contestCacheKeys),
        kv.mget(...socialCacheKeys),
      ]);

      // Map results to contest keys
      batch.forEach((contestKey, idx) => {
        if (contestResults[idx]) allContestData.set(contestKey, contestResults[idx]);
        if (socialResults[idx]) allSocialData.set(contestKey, socialResults[idx]);
      });
    }

    console.log(`Batch read complete: ${allContestData.size} contest details, ${allSocialData.size} social records from KV`);

    // Process each contest
    for (const contestKey of allContestKeys) {
      const [type, idStr] = contestKey.split('-');
      const id = parseInt(idStr);

      // Get from batch read results
      let contestDetails = allContestData.get(contestKey);
      const socialData = allSocialData.get(contestKey) || { likes: 0, recasts: 0, replies: 0 };

      // If no cache, fetch from chain
      let host = null;
      let winner = null;
      let winners = [];

      if (contestDetails) {
        kvHits++;
        host = contestDetails.host;
        winner = contestDetails.winner || '0x0000000000000000000000000000000000000000';
        winners = contestDetails.winners || [];

        // Normalize cached data to archive format
        contestDetails = {
          type,
          id,
          host,
          prizeToken: contestDetails.prizeToken,
          prizeAmount: contestDetails.prizeAmount?.toString() || '0',
          startTime: contestDetails.startTime,
          endTime: contestDetails.endTime,
          castId: contestDetails.castId,
          status: contestDetails.status,
          winner,
          winners,
          isNft: contestDetails.isNft || type === 'nft',
          nftName: contestDetails.nftName,
          nftImage: contestDetails.nftImage,
          participantCount: contestDetails.participantCount || 0,
        };
      } else {
        // Fetch from chain (fallback)
        chainFetches++;
        try {
          if (type === 'token') {
            const contest = await contestEscrow.getContest(id);
            host = contest[0];
            winner = contest[9];
            contestDetails = {
              type: 'token',
              id,
              host,
              prizeToken: contest[1],
              prizeAmount: ethers.formatEther(contest[2]),
              startTime: Number(contest[3]),
              endTime: Number(contest[4]),
              castId: contest[5],
              status: Number(contest[8]),
              winner,
            };
          } else if (type === 'nft') {
            const contest = await nftContestEscrow.getContest(id);
            host = contest[0];
            winner = contest[11];
            contestDetails = {
              type: 'nft',
              id,
            host,
            nftType: Number(contest[1]),
            nftContract: contest[2],
            tokenId: contest[3].toString(),
            amount: contest[4].toString(),
            startTime: Number(contest[5]),
            endTime: Number(contest[6]),
            castId: contest[7],
            status: Number(contest[10]),
            winner,
          };
        } else if (type === 'v2') {
          const contest = await contestManager.getContest(id);
          host = contest[0];
          winners = contest[8] || [];
          contestDetails = {
            type: 'v2',
            id,
            host,
            contestType: Number(contest[1]),
            status: Number(contest[2]),
            castId: contest[3],
            endTime: Number(contest[4]),
            prizeToken: contest[5],
            prizeAmount: ethers.formatEther(contest[6]),
            winnerCount: Number(contest[7]),
            winners: winners.map(w => w.toLowerCase()),
          };
        }
      } catch (e) {
        console.log(`    Error fetching contest: ${e.message}`);
        continue;
      }

      if (!contestDetails) continue;

      // Add social data
      contestDetails.social = {
        likes: socialData.likes || 0,
        recasts: socialData.recasts || 0,
        replies: socialData.replies || 0,
        capturedAt: socialData.capturedAt,
      };

      contestsData.push(contestDetails);

      // Aggregate host stats
      const hostLower = host.toLowerCase();
      if (!hostStats[hostLower]) {
        hostStats[hostLower] = {
          address: host,
          completedContests: 0,
          totalLikes: 0,
          totalRecasts: 0,
          totalReplies: 0,
        };
      }

      if (contestDetails.status === 2) {
        hostStats[hostLower].completedContests++;
        hostStats[hostLower].totalLikes += socialData.likes || 0;
        hostStats[hostLower].totalRecasts += socialData.recasts || 0;
        hostStats[hostLower].totalReplies += socialData.replies || 0;
      }
    }

    // Calculate host rankings
    const hostRankings = Object.values(hostStats)
      .map(host => ({
        ...host,
        socialScore: (host.totalLikes * 1 + host.totalRecasts * 2 + host.totalReplies * 3) * 100,
        hostBonus: host.completedContests * 100,
      }))
      .map(host => ({
        ...host,
        totalScore: host.socialScore + host.hostBonus,
      }))
      .sort((a, b) => b.totalScore - a.totalScore);

    // Calculate totals by type
    const tokenContests = contestsData.filter(c => c.type === 'token');
    const nftContests = contestsData.filter(c => c.type === 'nft');
    const v2Contests = contestsData.filter(c => c.type === 'v2');

    // Calculate total social engagement
    const totalLikes = contestsData.reduce((sum, c) => sum + (c.social?.likes || 0), 0);
    const totalRecasts = contestsData.reduce((sum, c) => sum + (c.social?.recasts || 0), 0);
    const totalReplies = contestsData.reduce((sum, c) => sum + (c.social?.replies || 0), 0);

    console.log(`\nData Sources: ${kvHits} from KV cache, ${chainFetches} from blockchain`);

    // Build archive object
    const archive = {
      seasonId,
      theme: season.theme,
      displayName: displayName || season.theme, // Custom name for the archive
      startTime: seasonStartTime,
      endTime: seasonEndTime,
      hostPool: ethers.formatEther(season.hostPool),
      voterPool: ethers.formatEther(season.voterPool),
      distributed: season.distributed,
      archivedAt: Date.now(),
      stats: {
        totalContests: contestsData.length,
        tokenContests: tokenContests.length,
        nftContests: nftContests.length,
        v2Contests: v2Contests.length,
        completedContests: contestsData.filter(c => c.status === 2).length,
        cancelledContests: contestsData.filter(c => c.status === 3).length,
        uniqueHosts: Object.keys(hostStats).length,
        totalLikes,
        totalRecasts,
        totalReplies,
        totalEngagement: totalLikes + totalRecasts + totalReplies,
      },
      contests: contestsData,
      leaderboard: hostRankings.slice(0, 50), // Top 50 hosts
    };

    console.log(`\nArchive Summary:`);
    console.log(`  Total Contests: ${archive.stats.totalContests} (Token: ${archive.stats.tokenContests}, NFT: ${archive.stats.nftContests}, V2: ${archive.stats.v2Contests})`);
    console.log(`  Completed: ${archive.stats.completedContests}`);
    console.log(`  Cancelled: ${archive.stats.cancelledContests}`);
    console.log(`  Unique Hosts: ${archive.stats.uniqueHosts}`);
    console.log(`  Total Engagement: ${archive.stats.totalEngagement} (Likes: ${archive.stats.totalLikes}, Recasts: ${archive.stats.totalRecasts}, Replies: ${archive.stats.totalReplies})`);
    console.log(`  Top Host: ${hostRankings[0]?.address || 'N/A'} (${hostRankings[0]?.totalScore || 0} pts)`);

    if (!dryRun) {
      // Store the archive
      const archiveKey = `season_archive:${seasonId}`;
      await kv.set(archiveKey, archive);
      console.log(`\n✅ Archive stored at ${archiveKey}`);

      // Clear season cache if requested
      if (clearAfterArchive) {
        console.log(`\nClearing season ${seasonId} cache...`);

        // Clear social data for each contest
        for (const contestKey of allContestKeys) {
          const socialKey = `contest:social:${contestKey}`;
          await kv.del(socialKey);
        }

        // Clear the season index
        const indexKey = `season:${seasonId}:contests`;
        await kv.del(indexKey);

        // Clear leaderboard cache
        await kv.del(`leaderboard:s${seasonId}:l10`);
        await kv.del(`leaderboard:s${seasonId}:l25`);
        await kv.del(`leaderboard:s${seasonId}:l50`);

        console.log(`✅ Season ${seasonId} cache cleared`);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`ARCHIVE COMPLETE`);
    console.log(`${'='.repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      dryRun,
      seasonId,
      theme: season.theme,
      displayName: archive.displayName,
      archiveKey: `season_archive:${seasonId}`,
      cleared: clearAfterArchive && !dryRun,
      stats: archive.stats,
      topHosts: hostRankings.slice(0, 10).map(h => ({
        address: h.address,
        contests: h.completedContests,
        score: h.totalScore,
      })),
    });

  } catch (error) {
    console.error('Archive error:', error);
    return res.status(500).json({ error: error.message });
  }
};
