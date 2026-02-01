/**
 * Periodic Cron - Daily Summary
 *
 * Runs periodically to count active contests for notifications.
 * Uses unified ContestManager for M- and T- prefix contests.
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

const CONTEST_STATUS = { Active: 0 };

/**
 * Count active contests (status = 0 and not ended)
 */
async function countActiveContests(provider) {
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);
  const now = Math.floor(Date.now() / 1000);
  let activeCount = 0;

  // Count Main contests
  try {
    const mainNextId = await contestManager.mainNextContestId();
    for (let i = 1n; i < mainNextId; i++) {
      try {
        const contest = await contestManager.getContestFull(i);
        const { endTime, status } = contest;
        if (Number(status) === CONTEST_STATUS.Active && Number(endTime) > now) {
          activeCount++;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.log('Error counting main contests:', e.message);
  }

  // Count Test contests
  try {
    const testNextId = await contestManager.testNextContestId();
    for (let i = 1n; i < testNextId; i++) {
      try {
        const contest = await contestManager.getTestContestFull(i);
        const { endTime, status } = contest;
        if (Number(status) === CONTEST_STATUS.Active && Number(endTime) > now) {
          activeCount++;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.log('Error counting test contests:', e.message);
  }

  return activeCount;
}

/**
 * Send daily notification about active contests
 */
async function sendDailySummary(activeCount) {
  if (activeCount === 0) {
    console.log('No active contests - skipping notification');
    return { sent: false, reason: 'no_active_contests' };
  }

  try {
    const { sendNotification } = require('./send-notification');
    await sendNotification('daily_summary', {
      activeContests: activeCount,
    });
    return { sent: true, activeContests: activeCount };
  } catch (e) {
    console.log('Failed to send notification:', e.message);
    return { sent: false, error: e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Count active contests
    const activeCount = await countActiveContests(provider);
    console.log(`Active contests: ${activeCount}`);

    // Check if it's midnight UTC for daily notification
    const now = new Date();
    const isNearMidnight = now.getUTCHours() === 0 && now.getUTCMinutes() < 30;

    let notification = { sent: false, reason: 'not_midnight' };
    if (isNearMidnight) {
      notification = await sendDailySummary(activeCount);
    }

    return res.status(200).json({
      success: true,
      activeContests: activeCount,
      notification,
      timestamp: now.toISOString(),
    });

  } catch (error) {
    console.error('Cron daily error:', error);
    return res.status(500).json({ error: error.message });
  }
};
