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
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
};

const CONTEST_MANAGER_ABI = [
  'function getContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
  'function getTestContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
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

    const ethPrice = await getETHPrice(provider);
    let totalETH = 0;
    let totalUSD = 0;
    let completedMainContests = 0;
    let completedTestContests = 0;

    // Process Main contests
    try {
      const mainNextId = await contestManager.mainNextContestId();
      for (let i = 1n; i < mainNextId; i++) {
        try {
          const contest = await contestManager.getContest(i);
          const { prizeType, prizeAmount, status } = contest;

          if (Number(status) !== CONTEST_STATUS.Completed) continue;
          completedMainContests++;

          if (Number(prizeType) === PRIZE_TYPE.ETH) {
            const ethAmount = Number(ethers.formatEther(prizeAmount));
            totalETH += ethAmount;
            totalUSD += ethAmount * ethPrice;
          }
          // For ERC20/NFT, would need stored price data
        } catch (e) {}
      }
    } catch (e) {
      console.log('Error processing main contests:', e.message);
    }

    // Process Test contests
    try {
      const testNextId = await contestManager.testNextContestId();
      for (let i = 1n; i < testNextId; i++) {
        try {
          const contest = await contestManager.getTestContest(i);
          const { prizeType, prizeAmount, status } = contest;

          if (Number(status) !== CONTEST_STATUS.Completed) continue;
          completedTestContests++;

          if (Number(prizeType) === PRIZE_TYPE.ETH) {
            const ethAmount = Number(ethers.formatEther(prizeAmount));
            totalETH += ethAmount;
            totalUSD += ethAmount * ethPrice;
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log('Error processing test contests:', e.message);
    }

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
