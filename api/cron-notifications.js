/**
 * Cron Notifications API
 *
 * Called by Vercel Cron to check for:
 * - Contests ending in 1 hour (send reminder)
 * - New #1 on leaderboard
 *
 * Uses unified ContestManager for M- and T- prefix contests.
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const PRIZE_TYPE = { ETH: 0, ERC20: 1, ERC721: 2, ERC1155: 3 };

async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress.toLowerCase()}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const users = data[walletAddress.toLowerCase()];
    return users?.[0] ? { fid: users[0].fid, username: users[0].username } : null;
  } catch (e) {
    return null;
  }
}

async function getTokenSymbol(provider, tokenAddress) {
  if (tokenAddress === '0x0000000000000000000000000000000000000000') return 'ETH';
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await token.symbol();
  } catch (e) {
    return 'TOKENS';
  }
}

async function hasNotifiedEndingSoon(contestId) {
  if (!process.env.KV_REST_API_URL) return false;
  try {
    const { kv } = await import('@vercel/kv');
    return await kv.exists(`notif:ending:${contestId}`);
  } catch (e) {
    return false;
  }
}

async function markNotifiedEndingSoon(contestId) {
  if (!process.env.KV_REST_API_URL) return;
  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(`notif:ending:${contestId}`, true, { ex: 86400 });
  } catch (e) {}
}

async function sendNotification(type, data) {
  try {
    const { sendNotification: send } = require('./send-notification');
    await send(type, data);
  } catch (e) {
    console.log('Could not send notification:', e.message);
  }
}

async function checkEndingSoonContests() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);

  const notifications = [];
  const now = Math.floor(Date.now() / 1000);
  const oneHour = 3600;

  // Check Main contests
  try {
    const mainNextId = await contestManager.mainNextContestId();
    for (let i = 1n; i < mainNextId; i++) {
      try {
        const contest = await contestManager.getContestFull(i);
        // Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
        const { host, contestType, status, endTime, prizeToken, prizeAmount } = contest;
        const contestEndTime = Number(endTime);

        // Skip if not active (status 0)
        if (Number(status) !== 0) continue;

        // Check if ending within 1 hour
        const timeUntilEnd = contestEndTime - now;
        if (timeUntilEnd > 0 && timeUntilEnd <= oneHour) {
          const contestId = `M-${i}`;
          if (await hasNotifiedEndingSoon(contestId)) continue;

          const hostUser = await getUserByWallet(host);
          let prizeDisplay = '';

          if (Number(contestType) === PRIZE_TYPE.ETH) {
            prizeDisplay = `${ethers.formatEther(prizeAmount)} ETH`;
          } else if (Number(contestType) === PRIZE_TYPE.ERC20) {
            const symbol = await getTokenSymbol(provider, prizeToken);
            prizeDisplay = `${ethers.formatEther(prizeAmount)} ${symbol}`;
          } else {
            prizeDisplay = 'NFT Prize';
          }

          await sendNotification('contest_ending_soon', {
            contestId,
            host: hostUser?.username || host.slice(0, 10),
            prize: prizeDisplay,
            minutesLeft: Math.round(timeUntilEnd / 60),
          });

          await markNotifiedEndingSoon(contestId);
          notifications.push({ contestId, type: 'ending_soon' });
        }
      } catch (e) {}
    }
  } catch (e) {
    console.log('Error checking main contests:', e.message);
  }

  // Check Test contests
  try {
    const testNextId = await contestManager.testNextContestId();
    for (let i = 1n; i < testNextId; i++) {
      try {
        const contest = await contestManager.getTestContestFull(i);
        const { host, contestType, status, endTime, prizeToken, prizeAmount } = contest;
        const contestEndTime = Number(endTime);

        if (Number(status) !== 0) continue;

        const timeUntilEnd = contestEndTime - now;
        if (timeUntilEnd > 0 && timeUntilEnd <= oneHour) {
          const contestId = `T-${i}`;
          if (await hasNotifiedEndingSoon(contestId)) continue;

          const hostUser = await getUserByWallet(host);
          let prizeDisplay = '';

          if (Number(contestType) === PRIZE_TYPE.ETH) {
            prizeDisplay = `${ethers.formatEther(prizeAmount)} ETH`;
          } else if (Number(contestType) === PRIZE_TYPE.ERC20) {
            const symbol = await getTokenSymbol(provider, prizeToken);
            prizeDisplay = `${ethers.formatEther(prizeAmount)} ${symbol}`;
          } else {
            prizeDisplay = 'NFT Prize';
          }

          await sendNotification('contest_ending_soon', {
            contestId,
            host: hostUser?.username || host.slice(0, 10),
            prize: prizeDisplay,
            minutesLeft: Math.round(timeUntilEnd / 60),
          });

          await markNotifiedEndingSoon(contestId);
          notifications.push({ contestId, type: 'ending_soon' });
        }
      } catch (e) {}
    }
  } catch (e) {
    console.log('Error checking test contests:', e.message);
  }

  return notifications;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const notifications = await checkEndingSoonContests();
    return res.status(200).json({
      success: true,
      notificationsSent: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error('Cron notifications error:', error);
    return res.status(500).json({ error: error.message });
  }
};
