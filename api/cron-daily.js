/**
 * Daily Cron - Active Contests Notification
 *
 * Runs at 12:00 AM UTC daily to notify subscribers about active contests.
 *
 * Vercel Cron Config (add to vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/cron-daily",
 *     "schedule": "0 0 * * *"  // Every day at midnight UTC
 *   }]
 * }
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
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
    });

  } catch (error) {
    console.error('Daily cron error:', error);
    return res.status(500).json({ error: error.message });
  }
};
