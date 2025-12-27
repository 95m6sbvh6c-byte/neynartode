#!/usr/bin/env node
/**
 * Archive Season Data
 *
 * Fetches all contests from a season and compiles leaderboard data.
 *
 * Usage:
 *   node archive-season.js --season 1
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  VOTING_MANAGER: '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8',
  BASE_RPC: 'https://mainnet.base.org',
  NEYNAR_API_KEY: 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const PRIZE_NFT_ABI = [
  'function seasons(uint256) external view returns (string theme, uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
];

const VOTING_MANAGER_ABI = [
  'function getHostVotes(address host) external view returns (uint256 upvotes, uint256 downvotes)',
];

async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress.toLowerCase()}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const users = data[walletAddress.toLowerCase()];
    if (users && users.length > 0) {
      return {
        fid: users[0].fid,
        username: users[0].username,
        displayName: users[0].display_name,
        pfpUrl: users[0].pfp_url,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let seasonId = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--season') seasonId = parseInt(args[++i]);
  }

  console.log(`\n📊 Archiving Season ${seasonId} Data`);
  console.log('='.repeat(40));

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
  const prizeNFT = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
  const votingContract = new ethers.Contract(CONFIG.VOTING_MANAGER, VOTING_MANAGER_ABI, provider);

  // Get season info
  const season = await prizeNFT.seasons(seasonId);
  const seasonStartTime = Number(season.startTime);
  const seasonEndTime = Number(season.endTime);

  console.log(`\n📅 Season ${seasonId}: "${season.theme}"`);
  console.log(`   Start: ${new Date(seasonStartTime * 1000).toISOString()}`);
  console.log(`   End:   ${new Date(seasonEndTime * 1000).toISOString()}`);
  console.log(`   Host Pool: ${ethers.formatEther(season.hostPool)} ETH`);
  console.log(`   Voter Pool: ${ethers.formatEther(season.voterPool)} ETH`);

  // Get all contests
  const nextContestId = await contestContract.nextContestId();
  const totalContests = Number(nextContestId) - 1;
  console.log(`\n🔍 Scanning ${totalContests} total contests...`);

  const seasonContests = [];
  const hostStats = {};

  for (let i = 1; i <= totalContests; i++) {
    try {
      const contest = await contestContract.getContest(i);
      const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenReq, volumeReq, status, winner] = contest;

      const contestEndTime = Number(endTime);

      // Check if contest ended within season time range
      if (contestEndTime >= seasonStartTime && contestEndTime <= seasonEndTime) {
        const contestData = {
          id: i,
          host,
          prizeToken,
          prizeAmount: ethers.formatEther(prizeAmount),
          startTime: Number(startTime),
          endTime: contestEndTime,
          castId,
          volumeRequirement: Number(volumeReq) / 1e18,
          status: Number(status),
          statusText: ['Active', 'PendingVRF', 'Completed', 'Cancelled'][Number(status)],
          winner,
        };

        seasonContests.push(contestData);

        // Aggregate host stats for completed contests
        if (Number(status) === 2) {
          const hostLower = host.toLowerCase();
          if (!hostStats[hostLower]) {
            hostStats[hostLower] = {
              address: host,
              contests: 0,
              totalVolume: 0,
              totalPrize: 0,
            };
          }
          hostStats[hostLower].contests++;
          hostStats[hostLower].totalVolume += Number(volumeReq) / 1e18;
          hostStats[hostLower].totalPrize += parseFloat(ethers.formatEther(prizeAmount));
        }
      }
    } catch (e) {
      console.error(`Error fetching contest ${i}:`, e.message);
    }
  }

  console.log(`\n✅ Found ${seasonContests.length} contests in Season ${seasonId}`);

  // Fetch user info and votes for hosts
  const leaderboard = [];
  for (const hostLower of Object.keys(hostStats)) {
    const stats = hostStats[hostLower];
    const userInfo = await getUserByWallet(stats.address);

    let upvotes = 0, downvotes = 0;
    try {
      const votes = await votingContract.getHostVotes(stats.address);
      upvotes = Number(votes[0]);
      downvotes = Number(votes[1]);
    } catch (e) {}

    leaderboard.push({
      address: stats.address,
      username: userInfo?.username || stats.address.slice(0, 10),
      displayName: userInfo?.displayName || 'Unknown',
      fid: userInfo?.fid || 0,
      contests: stats.contests,
      totalVolume: stats.totalVolume,
      totalPrize: stats.totalPrize.toFixed(4),
      upvotes,
      downvotes,
      score: stats.contests * 100 + (upvotes - downvotes) * 200,
    });
  }

  // Sort by score
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard.forEach((h, i) => h.rank = i + 1);

  // Compile archive
  const archive = {
    season: {
      id: seasonId,
      theme: season.theme,
      startTime: seasonStartTime,
      endTime: seasonEndTime,
      startDate: new Date(seasonStartTime * 1000).toISOString(),
      endDate: new Date(seasonEndTime * 1000).toISOString(),
      hostPool: ethers.formatEther(season.hostPool),
      voterPool: ethers.formatEther(season.voterPool),
      distributed: season.distributed,
    },
    summary: {
      totalContests: seasonContests.length,
      completedContests: seasonContests.filter(c => c.status === 2).length,
      totalHosts: leaderboard.length,
      archivedAt: new Date().toISOString(),
    },
    leaderboard,
    contests: seasonContests,
  };

  // Save to file
  const outputPath = path.join(__dirname, '..', 'data', `season-${seasonId}-archive.json`);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(archive, null, 2));

  console.log(`\n📁 Archive saved to: ${outputPath}`);

  // Print leaderboard
  console.log(`\n🏆 Season ${seasonId} Final Leaderboard:`);
  console.log('-'.repeat(60));
  for (const host of leaderboard.slice(0, 10)) {
    console.log(`   #${host.rank} ${host.username} - ${host.contests} contests, Score: ${host.score}`);
  }

  console.log('\n✅ Archive complete!');
}

main().catch(console.error);
