/**
 * All-Time Prizes API
 *
 * Calculates the total ETH prizes distributed across all completed contests.
 * Combines:
 *   - ETH contest prizes (from ContestEscrow)
 *   - NFT contest entry fees distributed (if any)
 *   - Distributed season host/voter pools
 *
 * Usage:
 *   GET /api/all-time-prizes
 *
 * Returns: { totalETH, contestPrizes, seasonPoolsDistributed, breakdown }
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const PRIZE_NFT_ABI = [
  'function seasons(uint256) external view returns (string theme, uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
  'function currentSeason() external view returns (uint256)',
];

// Cache results for 5 minutes to avoid excessive RPC calls
let cachedResult = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check cache
    const now = Date.now();
    if (cachedResult && (now - cacheTimestamp) < CACHE_DURATION) {
      return res.status(200).json({
        ...cachedResult,
        cached: true,
        cacheAge: Math.round((now - cacheTimestamp) / 1000),
      });
    }

    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contestEscrow = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftEscrow = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const prizeNFT = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);

    // Get contest counts
    const [ethNextId, nftNextId, currentSeason] = await Promise.all([
      contestEscrow.nextContestId(),
      nftEscrow.nextContestId().catch(() => 1n),
      prizeNFT.currentSeason().catch(() => 1n),
    ]);

    const totalEthContests = Number(ethNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;

    let totalContestPrizesWei = 0n;
    let completedEthContests = 0;
    let completedNftContests = 0;
    const breakdown = {
      ethContests: [],
      nftContests: [],
    };

    // Fetch all ETH contests and sum completed prizes
    console.log(`Checking ${totalEthContests} ETH contests...`);
    for (let i = 1; i <= totalEthContests; i++) {
      try {
        const contest = await contestEscrow.getContest(i);
        const [, prizeToken, prizeAmount, , , , , , status] = contest;

        // Only count completed contests (status 2)
        if (Number(status) === 2) {
          completedEthContests++;

          // Only count ETH prizes (token address = 0x0)
          if (prizeToken === '0x0000000000000000000000000000000000000000') {
            totalContestPrizesWei += prizeAmount;
            breakdown.ethContests.push({
              id: i,
              prizeETH: Number(ethers.formatEther(prizeAmount)),
            });
          }
        }
      } catch (e) {
        console.error(`Error fetching ETH contest ${i}:`, e.message);
      }
    }

    // Fetch all NFT contests (they don't have ETH prizes, but track completions)
    console.log(`Checking ${totalNftContests} NFT contests...`);
    for (let i = 1; i <= totalNftContests; i++) {
      try {
        const contest = await nftEscrow.getContest(i);
        const status = contest[10]; // status is at index 10 in V3 ABI

        if (Number(status) === 2) {
          completedNftContests++;
          breakdown.nftContests.push({ id: i });
        }
      } catch (e) {
        console.error(`Error fetching NFT contest ${i}:`, e.message);
      }
    }

    // Get distributed season pools
    let distributedSeasonPoolsWei = 0n;
    const distributedSeasons = [];

    console.log(`Checking ${Number(currentSeason)} seasons for distributed pools...`);
    for (let s = 1; s <= Number(currentSeason); s++) {
      try {
        const season = await prizeNFT.seasons(s);
        const [theme, , , hostPool, voterPool, distributed] = season;

        if (distributed) {
          const seasonTotal = hostPool + voterPool;
          distributedSeasonPoolsWei += seasonTotal;
          distributedSeasons.push({
            season: s,
            theme,
            hostPoolETH: Number(ethers.formatEther(hostPool)),
            voterPoolETH: Number(ethers.formatEther(voterPool)),
            totalETH: Number(ethers.formatEther(seasonTotal)),
          });
        }
      } catch (e) {
        console.error(`Error fetching season ${s}:`, e.message);
      }
    }

    // Calculate totals
    const contestPrizesETH = Number(ethers.formatEther(totalContestPrizesWei));
    const seasonPoolsETH = Number(ethers.formatEther(distributedSeasonPoolsWei));
    const totalETH = contestPrizesETH + seasonPoolsETH;

    const result = {
      totalETH: Math.round(totalETH * 10000) / 10000,
      contestPrizesETH: Math.round(contestPrizesETH * 10000) / 10000,
      seasonPoolsDistributedETH: Math.round(seasonPoolsETH * 10000) / 10000,
      stats: {
        totalEthContests,
        completedEthContests,
        totalNftContests,
        completedNftContests,
        currentSeason: Number(currentSeason),
        distributedSeasons: distributedSeasons.length,
      },
      distributedSeasons,
    };

    // Update cache
    cachedResult = result;
    cacheTimestamp = now;

    console.log(`All-time prizes: ${result.totalETH} ETH (${result.contestPrizesETH} contests + ${result.seasonPoolsDistributedETH} season pools)`);

    return res.status(200).json(result);

  } catch (error) {
    console.error('All-time prizes API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
