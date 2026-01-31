/**
 * All-Time Prizes API
 *
 * Calculates the total prize value distributed across all completed contests.
 * Uses unified ContestManager for M- and T- prefix contests.
 *
 * Usage:
 *   GET /api/all-time-prizes
 *
 * Returns: { totalUSD, totalETH, contestPrizes, breakdown }
 */

const { ethers } = require('ethers');
const { getETHPrice } = require('./lib/uniswap-volume');

const CONFIG = {
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
};

// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

const PRIZE_TYPE = { ETH: 0, ERC20: 1, ERC721: 2, ERC1155: 3 };
const CONTEST_STATUS = { Completed: 2 };

// Cache results for 5 minutes
let cachedResult = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000;

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
      return res.status(200).json(cachedResult);
    }

    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);

    // Get KV client for prize value lookups
    let kvClient = null;
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      kvClient = kv;
    }

    const ethPrice = await getETHPrice(provider);
    let totalETH = 0;
    let totalUSD = 0;
    let completedMainContests = 0;
    let completedTestContests = 0;

    // Helper to get prize USD value for a contest
    // Cap per-contest prize at $1M to filter corrupted price data
    const MAX_PRIZE_USD = 1_000_000;

    async function getContestPrizeUSD(contestType, prizeAmount, contestId) {
      const type = Number(contestType);
      let usd = 0;
      if (type === PRIZE_TYPE.ETH) {
        if (kvClient) {
          const cached = await kvClient.get(`contest_price_prize_${contestId}`).catch(() => null);
          if (cached?.prizeValueUSD) { usd = cached.prizeValueUSD; return Math.min(usd, MAX_PRIZE_USD); }
        }
        const ethAmount = Number(ethers.formatEther(prizeAmount));
        totalETH += ethAmount;
        return Math.min(ethAmount * ethPrice, MAX_PRIZE_USD);
      }
      if (type === PRIZE_TYPE.ERC20 && kvClient) {
        const priceData = await kvClient.get(`contest_price_prize_${contestId}`).catch(() => null);
        usd = priceData?.prizeValueUSD || 0;
        return Math.min(usd, MAX_PRIZE_USD);
      }
      if ((type === PRIZE_TYPE.ERC721 || type === PRIZE_TYPE.ERC1155) && kvClient) {
        const nftData = await kvClient.get(`nft_price_${contestId}`).catch(() => null);
        usd = nftData?.floorPriceUSD || 0;
        return Math.min(usd, MAX_PRIZE_USD);
      }
      return 0;
    }

    // Process Main contests
    try {
      const mainNextId = await contestManager.mainNextContestId();
      for (let i = 1n; i < mainNextId; i++) {
        try {
          const contest = await contestManager.getContestFull(i);
          const { contestType, prizeAmount, status } = contest;

          if (Number(status) !== CONTEST_STATUS.Completed) continue;
          completedMainContests++;

          totalUSD += await getContestPrizeUSD(contestType, prizeAmount, `M-${i}`);
        } catch (e) {}
      }
    } catch (e) {
      console.log('Error processing main contests:', e.message);
    }

    // Skip Test contests (T-) for production — only count M- contests
    completedTestContests = 0;

    const result = {
      totalUSD: Math.round(totalUSD * 100) / 100,
      totalETH: Math.round(totalETH * 10000) / 10000,
      ethPrice: Math.round(ethPrice * 100) / 100,
      completedContests: completedMainContests + completedTestContests,
      breakdown: {
        mainContests: completedMainContests,
        testContests: completedTestContests,
      },
      lastUpdated: new Date().toISOString(),
    };

    // Cache result
    cachedResult = result;
    cacheTimestamp = now;

    return res.status(200).json(result);

  } catch (error) {
    console.error('All-time prizes error:', error);
    return res.status(500).json({ error: error.message });
  }
};
