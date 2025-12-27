/**
 * All-Time Prizes API
 *
 * Calculates the total prize value distributed across all completed contests.
 * Now includes USD values for tokens and NFTs (stored at contest creation time).
 *
 * Combines:
 *   - ETH contest prizes (from ContestEscrow)
 *   - ERC-20 token contest prizes (USD value from stored prices)
 *   - NFT contest prizes (USD value from stored floor prices)
 *   - Distributed season host/voter pools
 *
 * Usage:
 *   GET /api/all-time-prizes
 *
 * Returns: { totalUSD, totalETH, contestPrizes, seasonPoolsDistributed, breakdown }
 */

const { ethers } = require('ethers');
const { getETHPrice } = require('./lib/uniswap-volume');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
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

/**
 * Fetch stored prize value from KV
 */
async function getStoredPrizeValue(contestId, type = 'token') {
  if (!process.env.KV_REST_API_URL) return null;

  try {
    const { kv } = require('@vercel/kv');
    const key = type === 'nft' ? `nft_price_NFT-${contestId}` : `contest_price_prize_${contestId}`;
    const data = await kv.get(key);
    return data;
  } catch (e) {
    return null;
  }
}

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

    // Get current ETH price for USD conversions
    const ethPriceUSD = await getETHPrice(provider);
    console.log(`Current ETH price: $${ethPriceUSD}`);

    // Get contest counts
    const [ethNextId, nftNextId, currentSeason] = await Promise.all([
      contestEscrow.nextContestId(),
      nftEscrow.nextContestId().catch(() => 1n),
      prizeNFT.currentSeason().catch(() => 1n),
    ]);

    const totalEthContests = Number(ethNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;

    let totalContestPrizesWei = 0n;
    let totalTokenPrizesUSD = 0;
    let totalNftPrizesUSD = 0;
    let completedEthContests = 0;
    let completedTokenContests = 0;
    let completedNftContests = 0;
    const breakdown = {
      ethContests: [],
      tokenContests: [],
      nftContests: [],
    };

    // Fetch all token contests and sum completed prizes
    console.log(`Checking ${totalEthContests} token contests...`);
    for (let i = 1; i <= totalEthContests; i++) {
      try {
        const contest = await contestEscrow.getContest(i);
        const [, prizeToken, prizeAmount, , , , , , status] = contest;

        // Only count completed contests (status 2)
        if (Number(status) === 2) {
          const isETHPrize = prizeToken === '0x0000000000000000000000000000000000000000';

          if (isETHPrize) {
            // ETH prize
            completedEthContests++;
            totalContestPrizesWei += prizeAmount;
            const prizeETH = Number(ethers.formatEther(prizeAmount));
            breakdown.ethContests.push({
              id: i,
              prizeETH,
              prizeUSD: Math.round(prizeETH * ethPriceUSD * 100) / 100,
            });
          } else {
            // ERC-20 token prize - try to get stored USD value
            completedTokenContests++;
            const storedPrice = await getStoredPrizeValue(i, 'token');
            const prizeUSD = storedPrice?.prizeValueUSD || 0;
            totalTokenPrizesUSD += prizeUSD;
            breakdown.tokenContests.push({
              id: i,
              tokenAddress: prizeToken,
              prizeUSD,
              hasStoredValue: !!storedPrice,
            });
          }
        }
      } catch (e) {
        console.error(`Error fetching token contest ${i}:`, e.message);
      }
    }

    // Fetch all NFT contests and get stored floor prices
    console.log(`Checking ${totalNftContests} NFT contests...`);
    for (let i = 1; i <= totalNftContests; i++) {
      try {
        const contest = await nftEscrow.getContest(i);
        const status = contest[10]; // status is at index 10 in V3 ABI

        if (Number(status) === 2) {
          completedNftContests++;

          // Try to get stored floor price value
          const storedPrice = await getStoredPrizeValue(i, 'nft');
          const prizeUSD = storedPrice?.floorPriceUSD || 0;
          totalNftPrizesUSD += prizeUSD;

          breakdown.nftContests.push({
            id: i,
            floorPriceETH: storedPrice?.floorPriceETH || null,
            prizeUSD,
            hasStoredValue: !!storedPrice,
          });
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
          const totalETH = Number(ethers.formatEther(seasonTotal));
          distributedSeasons.push({
            season: s,
            theme,
            hostPoolETH: Number(ethers.formatEther(hostPool)),
            voterPoolETH: Number(ethers.formatEther(voterPool)),
            totalETH,
            totalUSD: Math.round(totalETH * ethPriceUSD * 100) / 100,
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

    // Calculate USD totals
    const ethPrizesUSD = contestPrizesETH * ethPriceUSD;
    const seasonPoolsUSD = seasonPoolsETH * ethPriceUSD;
    const totalUSD = ethPrizesUSD + totalTokenPrizesUSD + totalNftPrizesUSD + seasonPoolsUSD;

    const result = {
      // USD totals (primary)
      totalUSD: Math.round(totalUSD * 100) / 100,
      ethPrizesUSD: Math.round(ethPrizesUSD * 100) / 100,
      tokenPrizesUSD: Math.round(totalTokenPrizesUSD * 100) / 100,
      nftPrizesUSD: Math.round(totalNftPrizesUSD * 100) / 100,
      seasonPoolsUSD: Math.round(seasonPoolsUSD * 100) / 100,
      // ETH totals (for backwards compatibility)
      totalETH: Math.round(totalETH * 10000) / 10000,
      contestPrizesETH: Math.round(contestPrizesETH * 10000) / 10000,
      seasonPoolsDistributedETH: Math.round(seasonPoolsETH * 10000) / 10000,
      // Current ETH price used
      ethPriceUSD: Math.round(ethPriceUSD * 100) / 100,
      // Stats
      stats: {
        totalEthContests,
        completedEthContests,
        completedTokenContests,
        totalNftContests,
        completedNftContests,
        currentSeason: Number(currentSeason),
        distributedSeasons: distributedSeasons.length,
        contestsWithStoredValue: breakdown.tokenContests.filter(c => c.hasStoredValue).length +
                                 breakdown.nftContests.filter(c => c.hasStoredValue).length,
      },
      distributedSeasons,
    };

    // Update cache
    cachedResult = result;
    cacheTimestamp = now;

    console.log(`All-time prizes: $${result.totalUSD} USD (ETH: $${result.ethPrizesUSD}, Tokens: $${result.tokenPrizesUSD}, NFTs: $${result.nftPrizesUSD}, Seasons: $${result.seasonPoolsUSD})`);

    return res.status(200).json(result);

  } catch (error) {
    console.error('All-time prizes API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
