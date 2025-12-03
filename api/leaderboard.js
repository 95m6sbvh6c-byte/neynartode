/**
 * Host Leaderboard API
 *
 * Fetches all completed contests, aggregates host stats, and calculates scores.
 * Now season-aware - filters contests by season time range.
 *
 * Scoring System:
 *   Total Score = Contest Score + Vote Score
 *   Contest Score = (Social x 3) + Token
 *   Vote Score = (Upvotes - Downvotes) x 200
 *   Social = (Likes x 1 + Recasts x 2 + Replies x 3) x 100
 *   Token = Volume Points x 50
 *
 * Usage:
 *   GET /api/leaderboard?limit=10&season=2
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  VOTING_MANAGER: '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  CURRENT_SEASON: 2, // Default active season
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

/**
 * Get Farcaster user info by wallet address
 */
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
        neynarScore: users[0].experimental?.neynar_user_score || 0,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Get cast engagement metrics from Neynar
 * Only counts engagement if the host is the original author of the cast
 *
 * @param {string} castHash - The cast hash to check
 * @param {number} hostFid - The host's Farcaster ID (to verify authorship)
 */
async function getCastEngagement(castHash, hostFid) {
  if (!castHash || castHash === '' || castHash.includes('|')) {
    return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
  }

  try {
    // Clean the cast hash - remove any prefix
    const cleanHash = castHash.startsWith('0x') ? castHash : `0x${castHash}`;

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${cleanHash}&type=hash`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return { likes: 0, recasts: 0, replies: 0, isAuthor: false };

    const data = await response.json();
    const cast = data.cast;

    if (!cast) return { likes: 0, recasts: 0, replies: 0, isAuthor: false };

    // Check if the host is the original author of this cast
    const authorFid = cast.author?.fid;
    const isAuthor = hostFid && authorFid && authorFid === hostFid;

    // Only count engagement if host authored the cast
    if (!isAuthor) {
      console.log(`   Cast ${cleanHash.slice(0, 10)}... authored by FID ${authorFid}, not host FID ${hostFid} - skipping engagement`);
      return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
    }

    if (cast.reactions) {
      return {
        likes: cast.reactions.likes_count || 0,
        recasts: cast.reactions.recasts_count || 0,
        replies: cast.replies?.count || 0,
        isAuthor: true,
      };
    }
    return { likes: 0, recasts: 0, replies: 0, isAuthor: true };
  } catch (e) {
    console.error('Error fetching cast engagement:', e.message);
    return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
  }
}

/**
 * Main handler
 */
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
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contestContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const prizeNFTContract = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
    const votingContract = new ethers.Contract(CONFIG.VOTING_MANAGER, VOTING_MANAGER_ABI, provider);

    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const seasonId = parseInt(req.query.season) || CONFIG.CURRENT_SEASON;

    // Get season time range for filtering
    let seasonStartTime = 0;
    let seasonEndTime = Infinity;
    let seasonInfo = null;

    try {
      const season = await prizeNFTContract.seasons(seasonId);
      seasonStartTime = Number(season.startTime);
      seasonEndTime = Number(season.endTime);
      seasonInfo = {
        id: seasonId,
        theme: season.theme,
        startTime: seasonStartTime,
        endTime: seasonEndTime,
        hostPool: ethers.formatEther(season.hostPool),
        voterPool: ethers.formatEther(season.voterPool),
      };
      console.log(`Filtering for Season ${seasonId}: ${new Date(seasonStartTime * 1000).toISOString()} to ${new Date(seasonEndTime * 1000).toISOString()}`);
    } catch (e) {
      console.error(`Error fetching season ${seasonId}:`, e.message);
    }

    // Get total contest count
    const nextContestId = await contestContract.nextContestId();
    const totalContests = Number(nextContestId) - 1;

    if (totalContests <= 0) {
      return res.status(200).json({
        hosts: [],
        totalContests: 0,
        season: seasonInfo,
      });
    }

    // Aggregate host stats
    const hostStats = {};
    let seasonContestCount = 0;

    // Fetch all contests
    for (let i = 1; i <= totalContests; i++) {
      try {
        const contestData = await contestContract.getContest(i);
        const [host, , , , endTime, castId, , volumeRequirement, status] = contestData;

        const contestEndTime = Number(endTime);

        // Filter by season time range - contest must END within season window
        if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
          continue; // Skip contests outside this season
        }

        seasonContestCount++;
        const hostLower = host.toLowerCase();

        if (!hostStats[hostLower]) {
          hostStats[hostLower] = {
            address: host,
            contests: 0,
            completedContests: 0,
            totalLikes: 0,
            totalRecasts: 0,
            totalReplies: 0,
            totalVolume: 0,
            castHashes: [],
          };
        }

        hostStats[hostLower].contests++;

        // Only count completed contests for scoring
        if (Number(status) === 2) {
          hostStats[hostLower].completedContests++;

          // Extract actual cast hash
          const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
          if (actualCastHash && actualCastHash !== '') {
            hostStats[hostLower].castHashes.push(actualCastHash);
          }

          // Add volume (stored in wei, convert to regular number)
          const volume = Number(volumeRequirement) / 1e18;
          hostStats[hostLower].totalVolume += volume;
        }
      } catch (e) {
        console.error(`Error fetching contest ${i}:`, e.message);
      }
    }

    // Fetch user info, engagement, and votes for all hosts
    const hostAddresses = Object.keys(hostStats);
    const hostsWithScores = [];

    for (const hostLower of hostAddresses) {
      const stats = hostStats[hostLower];

      // Skip hosts with no completed contests
      if (stats.completedContests === 0) continue;

      // First, get the host's Farcaster info (we need their FID to verify cast authorship)
      const userInfo = await getUserByWallet(stats.address);
      const hostFid = userInfo?.fid || 0;

      // Fetch engagement for each cast - only counts if host authored the cast
      let ownedCastsCount = 0;
      for (const castHash of stats.castHashes) {
        const engagement = await getCastEngagement(castHash, hostFid);
        if (engagement.isAuthor) {
          stats.totalLikes += engagement.likes;
          stats.totalRecasts += engagement.recasts;
          stats.totalReplies += engagement.replies;
          ownedCastsCount++;
        }
      }

      console.log(`   Host ${userInfo?.username || stats.address.slice(0,8)}: ${ownedCastsCount}/${stats.castHashes.length} casts authored by host`);

      // Fetch votes from VotingManager
      try {
        const [upvotes, downvotes] = await votingContract.getHostVotes(stats.address);
        stats.upvotes = Number(upvotes);
        stats.downvotes = Number(downvotes);
      } catch (e) {
        stats.upvotes = 0;
        stats.downvotes = 0;
      }

      // Scoring calculations:
      // Host Bonus = 100 points per completed contest (regardless of cast ownership)
      const hostBonus = stats.completedContests * 100;

      // Social = (Likes x 1 + Recasts x 2 + Replies x 3) x 100 (only from owned casts)
      const socialScore = (stats.totalLikes * 1 + stats.totalRecasts * 2 + stats.totalReplies * 3) * 100;

      // Token = Volume Points x 50
      const tokenScore = stats.totalVolume * 50;

      // Contest Score = Host Bonus + (Social x 3) + Token
      const contestScore = hostBonus + (socialScore * 3) + tokenScore;

      // Vote Score = (Upvotes - Downvotes) x 200
      const voteScore = (stats.upvotes - stats.downvotes) * 200;

      // Total Score = Contest Score + Vote Score
      const totalScore = contestScore + voteScore;

      hostsWithScores.push({
        address: stats.address,
        fid: hostFid,
        username: userInfo?.username || stats.address.slice(0, 8),
        displayName: userInfo?.displayName || 'Unknown',
        pfpUrl: userInfo?.pfpUrl || '',
        neynarScore: Math.round((userInfo?.neynarScore || 0) * 100) / 100,
        contests: stats.contests,
        completedContests: stats.completedContests,
        ownedCasts: ownedCastsCount,
        // Engagement breakdown (only from host's own casts)
        likes: stats.totalLikes,
        recasts: stats.totalRecasts,
        replies: stats.totalReplies,
        volume: stats.totalVolume,
        upvotes: stats.upvotes,
        downvotes: stats.downvotes,
        // Score breakdown
        hostBonus,
        socialScore,
        tokenScore,
        contestScore,
        voteScore,
        totalScore,
      });
    }

    // Sort by total score and get top N
    hostsWithScores.sort((a, b) => b.totalScore - a.totalScore);
    const topHosts = hostsWithScores.slice(0, limit).map((host, idx) => ({
      ...host,
      rank: idx + 1,
    }));

    return res.status(200).json({
      hosts: topHosts,
      season: seasonInfo,
      seasonContests: seasonContestCount,
      totalContests,
      totalHosts: hostsWithScores.length,
      scoringFormula: {
        total: 'Contest Score + Vote Score',
        contest: 'Host Bonus + (Social x 3) + Token',
        hostBonus: '100 points per completed contest',
        vote: '(Upvotes - Downvotes) x 200',
        social: '(Likes x 1 + Recasts x 2 + Replies x 3) x 100',
        token: 'Volume Points x 50',
      },
    });

  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
