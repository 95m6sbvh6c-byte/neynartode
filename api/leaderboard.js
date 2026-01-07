/**
 * Host Leaderboard API
 *
 * Fetches all completed contests from the unified ContestManager,
 * aggregates host stats, and calculates scores.
 *
 * Scoring System:
 *   Total Score = Contest Score + Vote Score
 *   Contest Score = Host Bonus + (Social x Contests) + Token
 *   Host Bonus = 100 points per completed contest
 *   Social Multiplier = Social Score x completed contests
 *   Vote Score = (Upvotes - Downvotes) x 200
 *   Social = (Likes x 1 + Recasts x 2 + Replies x 3) x 100
 *   Token = Token Holdings / 50,000
 *
 * Usage:
 *   GET /api/leaderboard?limit=10
 */

const { ethers } = require('ethers');
const { getUserByWallet: getCachedUserByWallet, getCached, setCache } = require('./lib/utils');

const CONFIG = {
  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  VOTING_MANAGER: '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Excluded from leaderboard (devs/admins)
const EXCLUDED_FIDS = [1188162];
const EXCLUDED_ADDRESSES = [
  '0x78eeaa6f014667a339fcf8b4ecd74743366603fb',
  '0x6b814f71712ad9e5b2299676490ce530797f9ec7',
  '0xab4f21321a7a16eb57171994c7d7d1c808506e5d',
  '0x64cb30c6d5e1dc5e675296cf13d547150c71c2b1',
];

// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

const VOTING_MANAGER_ABI = [
  'function getHostVotes(address host) external view returns (uint256 upvotes, uint256 downvotes)',
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// Contest status
const CONTEST_STATUS = { Active: 0, PendingVRF: 1, Completed: 2, Cancelled: 3 };

async function getUserByWallet(walletAddress) {
  try {
    const user = await getCachedUserByWallet(walletAddress);
    if (!user) return null;

    const verifiedAddresses = user.verified_addresses?.eth_addresses || [];
    const custodyAddress = user.custody_address;
    const allAddresses = [...new Set([...verifiedAddresses, custodyAddress].filter(Boolean))];

    return {
      fid: user.fid,
      username: user.username,
      displayName: user.display_name,
      pfpUrl: user.pfp_url,
      neynarScore: user.experimental?.neynar_user_score || 0,
      verifiedAddresses: allAddresses,
    };
  } catch (e) {
    return null;
  }
}

async function getTokenHoldings(addresses, tokenContract, kvClient = null) {
  let totalBalance = 0n;

  for (const addr of addresses) {
    const addrLower = addr.toLowerCase();
    const kvCacheKey = `holdings:${addrLower}`;

    if (kvClient) {
      try {
        const cached = await kvClient.get(kvCacheKey);
        if (cached && cached.balance !== undefined) {
          if (Date.now() - cached.updatedAt < 3600000) {
            totalBalance += BigInt(cached.balance);
            continue;
          }
        }
      } catch (e) { }
    }

    let balance = 0n;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        balance = await tokenContract.balanceOf(addr);
        totalBalance += BigInt(balance);

        if (kvClient) {
          try {
            await kvClient.set(kvCacheKey, {
              balance: balance.toString(),
              updatedAt: Date.now(),
            }, { ex: 3600 });
          } catch (e) { }
        }
        break;
      } catch (e) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }
  }

  return Number(totalBalance / 10n ** 18n);
}

async function getCastEngagement(contestInfo, hostFid, kv = null) {
  const { castHash, type, id } = contestInfo;

  if (!castHash || castHash === '' || castHash.includes('|')) {
    return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
  }

  const cleanHash = castHash.startsWith('0x') ? castHash : `0x${castHash}`;
  const memoryCacheKey = `cast:engagement:${cleanHash}:${hostFid}`;
  const cached = getCached(memoryCacheKey, 300000);
  if (cached !== null) return cached;

  // Check KV cache
  if (kv && type && id) {
    try {
      const kvCacheKey = `contest:social:${type}-${id}`;
      const kvCached = await kv.get(kvCacheKey);

      if (kvCached) {
        if (hostFid && kvCached.hostFid && kvCached.hostFid !== hostFid) {
          const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
          setCache(memoryCacheKey, result, 300000);
          return result;
        }

        const result = {
          likes: kvCached.likes || 0,
          recasts: kvCached.recasts || 0,
          replies: kvCached.replies || 0,
          isAuthor: true,
          fromKVCache: true,
        };
        setCache(memoryCacheKey, result, 300000);
        return result;
      }
    } catch (e) { }
  }

  // Fetch from Neynar API
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${cleanHash}&type=hash`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) {
      const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
      setCache(memoryCacheKey, result, 60000);
      return result;
    }

    const data = await response.json();
    const cast = data.cast;

    if (!cast) {
      const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
      setCache(memoryCacheKey, result, 60000);
      return result;
    }

    const authorFid = cast.author?.fid;
    const isAuthor = hostFid && authorFid && authorFid === hostFid;

    if (!isAuthor) {
      const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
      setCache(memoryCacheKey, result, 300000);
      return result;
    }

    const result = {
      likes: cast.reactions?.likes_count || 0,
      recasts: cast.reactions?.recasts_count || 0,
      replies: cast.replies?.count || 0,
      isAuthor: true,
    };
    setCache(memoryCacheKey, result, 300000);

    // Store in KV
    if (kv && type && id) {
      try {
        const kvCacheKey = `contest:social:${type}-${id}`;
        await kv.set(kvCacheKey, {
          likes: result.likes,
          recasts: result.recasts,
          replies: result.replies,
          castHash: cleanHash,
          hostFid: authorFid,
          capturedAt: Date.now(),
        });
      } catch (e) { }
    }

    return result;
  } catch (e) {
    return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
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

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600, max-age=60');

  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  // Check KV cache
  const kvCacheKey = `leaderboard:unified:l${limit}`;
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      const cached = await kv.get(kvCacheKey);
      if (cached) {
        console.log('Returning cached leaderboard');
        return res.status(200).json(cached);
      }
    } catch (e) {
      console.log('KV cache check failed:', e.message);
    }
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);
    const votingContract = new ethers.Contract(CONFIG.VOTING_MANAGER, VOTING_MANAGER_ABI, provider);
    const tokenContract = new ethers.Contract(CONFIG.NEYNARTODES_TOKEN, ERC20_ABI, provider);

    let kvClient = null;
    if (process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        kvClient = kv;
      } catch (e) { }
    }

    // Get contest counts
    const [mainNextId, testNextId] = await Promise.all([
      contestManager.mainNextContestId(),
      contestManager.testNextContestId(),
    ]);

    const totalMainContests = Number(mainNextId) - 1;
    const totalTestContests = Number(testNextId) - 1;
    const totalContests = totalMainContests + totalTestContests;

    console.log(`Total contests: ${totalContests} (Main: ${totalMainContests}, Test: ${totalTestContests})`);

    if (totalContests <= 0) {
      return res.status(200).json({
        hosts: [],
        totalContests: 0,
      });
    }

    const hostStats = {};
    const BATCH_SIZE = 5;
    const BATCH_DELAY = 500;

    // Process Main contests (M-)
    for (let i = 1; i <= totalMainContests; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, totalMainContests + 1); j++) {
        batch.push(j);
      }

      const contestPromises = batch.map(id =>
        contestManager.getContestFull(id).catch(() => null)
      );
      const contestResults = await Promise.all(contestPromises);

      if (i + BATCH_SIZE <= totalMainContests) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }

      for (let j = 0; j < batch.length; j++) {
        const contest = contestResults[j];
        if (!contest) continue;

        const { host, castId, status } = contest;
        const hostLower = host.toLowerCase();

        if (EXCLUDED_ADDRESSES.includes(hostLower)) continue;

        if (!hostStats[hostLower]) {
          hostStats[hostLower] = {
            address: host,
            contests: 0,
            completedContests: 0,
            totalLikes: 0,
            totalRecasts: 0,
            totalReplies: 0,
            contestInfos: [],
          };
        }

        hostStats[hostLower].contests++;

        if (Number(status) === CONTEST_STATUS.Completed) {
          hostStats[hostLower].completedContests++;

          const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
          if (actualCastHash && actualCastHash !== '') {
            hostStats[hostLower].contestInfos.push({
              castHash: actualCastHash,
              type: 'M',
              id: batch[j],
            });
          }
        }
      }
    }

    // Process Test contests (T-)
    for (let i = 1; i <= totalTestContests; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, totalTestContests + 1); j++) {
        batch.push(j);
      }

      const contestPromises = batch.map(id =>
        contestManager.getTestContestFull(id).catch(() => null)
      );
      const contestResults = await Promise.all(contestPromises);

      if (i + BATCH_SIZE <= totalTestContests) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }

      for (let j = 0; j < batch.length; j++) {
        const contest = contestResults[j];
        if (!contest) continue;

        const { host, castId, status } = contest;
        const hostLower = host.toLowerCase();

        if (EXCLUDED_ADDRESSES.includes(hostLower)) continue;

        if (!hostStats[hostLower]) {
          hostStats[hostLower] = {
            address: host,
            contests: 0,
            completedContests: 0,
            totalLikes: 0,
            totalRecasts: 0,
            totalReplies: 0,
            contestInfos: [],
          };
        }

        hostStats[hostLower].contests++;

        if (Number(status) === CONTEST_STATUS.Completed) {
          hostStats[hostLower].completedContests++;

          const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
          if (actualCastHash && actualCastHash !== '') {
            hostStats[hostLower].contestInfos.push({
              castHash: actualCastHash,
              type: 'T',
              id: batch[j],
            });
          }
        }
      }
    }

    // Process host scores
    const hostAddresses = Object.keys(hostStats);
    const hostsWithScores = [];
    const activeHosts = hostAddresses.filter(h => hostStats[h].completedContests > 0);

    // Batch fetch user info
    const USER_BATCH_SIZE = 5;
    const userInfoMap = new Map();

    for (let i = 0; i < activeHosts.length; i += USER_BATCH_SIZE) {
      const batch = activeHosts.slice(i, i + USER_BATCH_SIZE);
      const userInfoPromises = batch.map(hostLower =>
        getUserByWallet(hostStats[hostLower].address).then(info => ({ hostLower, info }))
      );
      const results = await Promise.all(userInfoPromises);
      results.forEach(({ hostLower, info }) => userInfoMap.set(hostLower, info));
    }

    // Calculate scores for each host
    for (const hostLower of activeHosts) {
      const stats = hostStats[hostLower];
      const userInfo = userInfoMap.get(hostLower);
      const hostFid = userInfo?.fid || 0;

      if (EXCLUDED_FIDS.includes(hostFid)) continue;

      // Fetch cast engagements
      let ownedCastsCount = 0;
      const engagementPromises = stats.contestInfos.map(contestInfo =>
        getCastEngagement(contestInfo, hostFid, kvClient)
      );
      const engagements = await Promise.all(engagementPromises);

      engagements.forEach(engagement => {
        if (engagement.isAuthor) {
          stats.totalLikes += engagement.likes;
          stats.totalRecasts += engagement.recasts;
          stats.totalReplies += engagement.replies;
          ownedCastsCount++;
        }
      });

      // Fetch votes and token holdings
      const holdingsAddresses = [...new Set([stats.address, ...(userInfo?.verifiedAddresses || [])])];
      const [votesResult, tokenHoldings] = await Promise.all([
        votingContract.getHostVotes(stats.address).catch(() => [0n, 0n]),
        getTokenHoldings(holdingsAddresses, tokenContract, kvClient)
      ]);

      const [upvotes, downvotes] = votesResult;
      stats.upvotes = Number(upvotes);
      stats.downvotes = Number(downvotes);

      // Calculate scores
      const hostBonus = stats.completedContests * 100;
      const socialScore = (stats.totalLikes * 1 + stats.totalRecasts * 2 + stats.totalReplies * 3) * 100;
      const tokenScore = Math.floor(tokenHoldings / 50000);
      const socialMultiplier = stats.completedContests;
      const contestScore = hostBonus + (socialScore * socialMultiplier) + tokenScore;
      const voteScore = (stats.upvotes - stats.downvotes) * 200;
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
        likes: stats.totalLikes,
        recasts: stats.totalRecasts,
        replies: stats.totalReplies,
        tokenHoldings,
        upvotes: stats.upvotes,
        downvotes: stats.downvotes,
        hostBonus,
        socialScore,
        socialMultiplier,
        tokenScore,
        contestScore,
        voteScore,
        totalScore,
      });
    }

    // Sort and get top N
    hostsWithScores.sort((a, b) => b.totalScore - a.totalScore);
    const topHosts = hostsWithScores.slice(0, limit).map((host, idx) => ({
      ...host,
      rank: idx + 1,
    }));

    // Check for leader change notification
    if (topHosts.length > 0 && process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        const currentLeader = topHosts[0];
        const kvKey = 'leaderboard_leader_unified';
        const previousLeaderFid = await kv.get(kvKey);

        if (previousLeaderFid && previousLeaderFid !== currentLeader.fid) {
          console.log(`New #1 leader: ${currentLeader.username}`);
          const { sendNotification } = require('./send-notification');
          await sendNotification('new_leaderboard_leader', {
            username: currentLeader.username,
            fid: currentLeader.fid,
            score: currentLeader.totalScore,
          });
        }

        await kv.set(kvKey, currentLeader.fid);
      } catch (e) {
        console.log('Could not check/update leader:', e.message);
      }
    }

    const response = {
      hosts: topHosts,
      totalContests,
      totalHosts: hostsWithScores.length,
      scoringFormula: {
        total: 'Contest Score + Vote Score',
        contest: 'Host Bonus + (Social x Contests) + Token',
        hostBonus: '100 points per completed contest',
        socialMultiplier: 'Social Score x completed contests',
        vote: '(Upvotes - Downvotes) x 200',
        social: '(Likes x 1 + Recasts x 2 + Replies x 3) x 100',
        token: 'Token Holdings / 50,000',
      },
    };

    // Cache response
    if (process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        await kv.set(kvCacheKey, response, { ex: 300 });
      } catch (e) { }
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
