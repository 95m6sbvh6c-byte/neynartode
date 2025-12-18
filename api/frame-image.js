/**
 * Frame Image API
 *
 * Generates dynamic images for Farcaster Frame embeds.
 * Shows contest info, prize, time remaining, and entry status.
 *
 * GET /api/frame-image?contestId=30
 * GET /api/frame-image?contestId=30&status=entered
 *
 * Returns: SVG image
 */

const { ethers } = require('ethers');

const CONFIG = {
  BASE_RPC_URL: 'https://mainnet.base.org',
  CONTEST_ESCROW: '0xEDE1Af4abfD069FFB14b5D3C0BBFf681Ec56BDF5'
};

const ESCROW_ABI = [
  'function getContest(uint256) view returns (address host, uint256 prizeAmount, uint256 endTime, bool finalized, bytes32 requirements, address tokenAddress, uint256 minTradeVolume, uint256 tokenRequirement)'
];

async function getContestInfo(contestId) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC_URL);
    const escrow = new ethers.Contract(CONFIG.CONTEST_ESCROW, ESCROW_ABI, provider);

    const contest = await escrow.getContest(contestId);

    return {
      prizeAmount: ethers.formatUnits(contest.prizeAmount, 18),
      endTime: Number(contest.endTime),
      finalized: contest.finalized
    };
  } catch (e) {
    console.error('Error fetching contest:', e.message);
    return null;
  }
}

function formatTimeRemaining(endTime) {
  const now = Math.floor(Date.now() / 1000);
  const diff = endTime - now;

  if (diff <= 0) return 'Ended';

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function formatPrize(amount) {
  const num = parseFloat(amount);
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toFixed(0);
}

module.exports = async (req, res) => {
  const { contestId, status } = req.query;

  if (!contestId) {
    return res.status(400).send('Missing contestId');
  }

  // Get contest info
  const contestInfo = await getContestInfo(contestId);

  const prizeDisplay = contestInfo ? formatPrize(contestInfo.prizeAmount) : '???';
  const timeDisplay = contestInfo ? formatTimeRemaining(contestInfo.endTime) : 'Unknown';
  const isEnded = contestInfo?.finalized || (contestInfo?.endTime && contestInfo.endTime < Date.now() / 1000);

  // Determine status display
  let statusText = 'Enter Raffle';
  let statusColor = '#22c55e'; // green

  if (status === 'entered') {
    statusText = 'Entered ✓';
    statusColor = '#6b7280'; // gray
  } else if (status === 'needs_signer') {
    statusText = 'Authorize App';
    statusColor = '#f59e0b'; // yellow
  } else if (isEnded) {
    statusText = 'Contest Ended';
    statusColor = '#ef4444'; // red
  }

  // Generate SVG image (1200x630 for 1.91:1 aspect ratio)
  const svg = `
<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Border -->
  <rect x="20" y="20" width="1160" height="590" rx="20" fill="none" stroke="#8b5cf6" stroke-width="3"/>

  <!-- Logo/Title -->
  <text x="600" y="120" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">
    NEYNARtodes
  </text>

  <!-- Contest ID -->
  <text x="600" y="180" font-family="Arial, sans-serif" font-size="32" fill="#a78bfa" text-anchor="middle">
    Contest #${contestId}
  </text>

  <!-- Prize Box -->
  <rect x="350" y="220" width="500" height="120" rx="15" fill="#1e1e3f" stroke="#8b5cf6" stroke-width="2"/>
  <text x="600" y="270" font-family="Arial, sans-serif" font-size="24" fill="#9ca3af" text-anchor="middle">
    PRIZE
  </text>
  <text x="600" y="320" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="#f0abfc" text-anchor="middle">
    ${prizeDisplay} Tokens
  </text>

  <!-- Time Remaining -->
  <text x="600" y="400" font-family="Arial, sans-serif" font-size="28" fill="#6b7280" text-anchor="middle">
    ${timeDisplay}
  </text>

  <!-- Status Button -->
  <rect x="400" y="450" width="400" height="80" rx="40" fill="${statusColor}"/>
  <text x="600" y="505" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#ffffff" text-anchor="middle">
    ${statusText}
  </text>

  <!-- Footer -->
  <text x="600" y="590" font-family="Arial, sans-serif" font-size="18" fill="#6b7280" text-anchor="middle">
    Like + Recast to enter | Reply for bonus entry
  </text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=60'); // Cache for 1 minute
  return res.status(200).send(svg);
};
