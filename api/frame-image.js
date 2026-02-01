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
  BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
};

// Use getContestFull/getTestContestFull for full struct data
// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
];

const CONTEST_STATUS = { Completed: 2 };

async function getContestInfo(contestIdStr) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC_URL);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);

    // Parse contest ID (M-1, T-1, etc.)
    const isTestContest = contestIdStr.startsWith('T-');
    const numericId = parseInt(contestIdStr.replace(/^[MT]-/, ''));

    const contest = isTestContest
      ? await contestManager.getTestContestFull(numericId)
      : await contestManager.getContestFull(numericId);

    return {
      prizeAmount: ethers.formatEther(contest.prizeAmount),
      endTime: Number(contest.endTime),
      finalized: Number(contest.status) === CONTEST_STATUS.Completed,
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
  const isEntered = status === 'entered';

  if (isEntered) {
    statusText = 'You\'re Entered! 🎉';
    statusColor = '#8b5cf6'; // purple for celebration
  } else if (status === 'needs_signer') {
    statusText = 'Authorize App';
    statusColor = '#f59e0b'; // yellow
  } else if (isEnded) {
    statusText = 'Contest Ended';
    statusColor = '#ef4444'; // red
  }

  // Generate confetti elements for celebration
  function generateConfetti() {
    const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff6bff', '#6bffff'];
    let confetti = '';
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * 1200;
      const delay = Math.random() * 2;
      const duration = 2 + Math.random() * 2;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const size = 8 + Math.random() * 12;
      const rotation = Math.random() * 360;

      confetti += `
      <rect x="${x}" y="-20" width="${size}" height="${size * 0.6}" fill="${color}" transform="rotate(${rotation} ${x} -20)">
        <animate attributeName="y" from="-20" to="650" dur="${duration}s" begin="${delay}s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;1;0" dur="${duration}s" begin="${delay}s" repeatCount="indefinite"/>
        <animateTransform attributeName="transform" type="rotate" from="${rotation} ${x} -20" to="${rotation + 360} ${x} 650" dur="${duration}s" begin="${delay}s" repeatCount="indefinite" additive="sum"/>
      </rect>`;
    }
    return confetti;
  }

  // Generate pulsing Neynartodes logos
  function generateNeynartodes() {
    let logos = '';
    const logoUrl = 'https://frame-opal-eight.vercel.app/neynartode-sticker.png';
    const positions = [
      {x: 80, y: 60, size: 60}, {x: 1060, y: 60, size: 60},
      {x: 50, y: 280, size: 50}, {x: 1100, y: 280, size: 50},
      {x: 100, y: 480, size: 55}, {x: 1050, y: 480, size: 55},
      {x: 180, y: 180, size: 45}, {x: 970, y: 180, size: 45},
      {x: 130, y: 380, size: 40}, {x: 1020, y: 380, size: 40}
    ];
    positions.forEach((pos, i) => {
      logos += `
      <image href="${logoUrl}" x="${pos.x}" y="${pos.y}" width="${pos.size}" height="${pos.size}" opacity="0.9">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" begin="${i * 0.3}s" repeatCount="indefinite"/>
        <animateTransform attributeName="transform" type="scale" values="0.9;1.1;0.9" dur="2s" begin="${i * 0.3}s" repeatCount="indefinite" additive="sum"/>
      </image>`;
    });
    return logos;
  }

  const confettiElements = isEntered ? generateConfetti() : '';
  const neynartodeElements = isEntered ? generateNeynartodes() : '';
  const celebrationTitle = isEntered ? '🎊 CONGRATULATIONS! 🎊' : 'NEYNARtodes';
  const footerText = isEntered ? 'Reply to the cast for a BONUS entry!' : 'Like + Recast to enter | Reply for bonus entry';

  // Generate SVG image (1200x630 for 1.91:1 aspect ratio)
  const svg = `
<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${isEntered ? '#1a0a2e' : '#1a1a2e'};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${isEntered ? '#2e1a4e' : '#16213e'};stop-opacity:1" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Border -->
  <rect x="20" y="20" width="1160" height="590" rx="20" fill="none" stroke="${isEntered ? '#ffd700' : '#8b5cf6'}" stroke-width="${isEntered ? '4' : '3'}"/>

  ${confettiElements}
  ${neynartodeElements}

  <!-- Logo/Title -->
  <text x="600" y="120" font-family="Arial, sans-serif" font-size="${isEntered ? '52' : '64'}" font-weight="bold" fill="${isEntered ? '#ffd700' : '#ffffff'}" text-anchor="middle">
    ${celebrationTitle}
  </text>

  <!-- Contest ID -->
  <text x="600" y="180" font-family="Arial, sans-serif" font-size="32" fill="#a78bfa" text-anchor="middle">
    Contest #${contestId}
  </text>

  <!-- Prize Box -->
  <rect x="350" y="220" width="500" height="120" rx="15" fill="${isEntered ? '#2e1a4e' : '#1e1e3f'}" stroke="${isEntered ? '#ffd700' : '#8b5cf6'}" stroke-width="2"/>
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
  <text x="600" y="505" font-family="Arial, sans-serif" font-size="${isEntered ? '28' : '32'}" font-weight="bold" fill="#ffffff" text-anchor="middle">
    ${statusText}
  </text>

  <!-- Footer -->
  <text x="600" y="590" font-family="Arial, sans-serif" font-size="18" fill="${isEntered ? '#ffd700' : '#6b7280'}" text-anchor="middle">
    ${footerText}
  </text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=60'); // Cache for 1 minute
  return res.status(200).send(svg);
};
