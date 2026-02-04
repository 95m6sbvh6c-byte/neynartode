/**
 * Host Leaderboard API
 *
 * Fetches all completed contests from the unified ContestManager,
 * aggregates host stats, and calculates scores.
 *
 * Scoring System:
 *   Total Score = Entry Score + Vote Score + Token Score + Prize Score
 *   Entry Score = 100 points per contest entry received
 *   Vote Score = 100 points per net vote (upvotes - downvotes)
 *   Token Score = 10 points per 1,000,000 NEYNARTODES held
 *   Prize Score = 500 points per $1 USD given away in completed contests
 *
 * Usage:
 *   GET /api/leaderboard?limit=10
 */

const { ethers } = require('ethers');
const { getUserByWallet: getCachedUserByWallet } = require('./lib/utils');
const { getETHPrice, getTokenPriceUSD } = require('./lib/uniswap-volume');

const CONFIG = {
  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  VOTING_MANAGER: '0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB',  // V3
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Excluded from leaderboard (devs/admins)
// Note: Exclusions disabled for test mode - all hosts visible
const EXCLUDED_FIDS = [1891537];
const EXCLUDED_ADDRESSES = [
  // Disabled for testing - uncomment for production:
  // '0x78eeaa6f014667a339fcf8b4ecd74743366603fb',
  // '0x6b814f71712ad9e5b2299676490ce530797f9ec7',
  // '0xab4f21321a7a16eb57171994c7d7d1c808506e5d',
  // '0x64cb30c6d5e1dc5e675296cf13d547150c71c2b1',
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
          if (Date.now() - cached.updatedAt < 600000) {  // 10 minutes
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
            }, { ex: 600 });  // 10 minutes
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

        const { host, status, contestType, prizeAmount, prizeToken } = contest;
        const hostLower = host.toLowerCase();

        if (EXCLUDED_ADDRESSES.includes(hostLower)) continue;

        if (!hostStats[hostLower]) {
          hostStats[hostLower] = {
            address: host,
            contests: 0,
            completedContests: 0,
            completedContestIds: [],
          };
        }

        hostStats[hostLower].contests++;

        if (Number(status) === CONTEST_STATUS.Completed) {
          hostStats[hostLower].completedContests++;
          hostStats[hostLower].completedContestIds.push({
            id: `M-${batch[j]}`,
            contestType: Number(contestType),
            prizeAmount: prizeAmount.toString(),
            prizeToken: prizeToken,
          });
        }
      }
    }

    // Skip Test contests (T-) for production — only score M- contests
    const INCLUDE_TEST_CONTESTS = false;
    for (let i = 1; INCLUDE_TEST_CONTESTS && i <= totalTestContests; i += BATCH_SIZE) {
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

        const { host, status, contestType, prizeAmount } = contest;
        const hostLower = host.toLowerCase();

        if (EXCLUDED_ADDRESSES.includes(hostLower)) continue;

        if (!hostStats[hostLower]) {
          hostStats[hostLower] = {
            address: host,
            contests: 0,
            completedContests: 0,
            completedContestIds: [],
          };
        }

        hostStats[hostLower].contests++;

        if (Number(status) === CONTEST_STATUS.Completed) {
          hostStats[hostLower].completedContests++;
          hostStats[hostLower].completedContestIds.push({
            id: `T-${batch[j]}`,
            contestType: Number(contestType),
            prizeAmount: prizeAmount.toString(),
          });
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

    // Fetch ETH price once for prize value calculations
    let ethPriceUSD = 0;
    try {
      ethPriceUSD = await getETHPrice();
    } catch (e) {
      console.log('Error fetching ETH price:', e.message);
    }

    // Calculate scores for each host
    for (const hostLower of activeHosts) {
      const stats = hostStats[hostLower];
      const userInfo = userInfoMap.get(hostLower);
      const hostFid = userInfo?.fid || 0;

      if (EXCLUDED_FIDS.includes(hostFid)) continue;

      // Fetch entry counts from KV for all completed contests
      let totalEntries = 0;
      if (kvClient && stats.completedContestIds.length > 0) {
        try {
          const entryPromises = stats.completedContestIds.map(async (c) => {
            const count = await kvClient.scard(`contest_entries:${c.id}`).catch(() => 0);
            return count || 0;
          });
          const entryCounts = await Promise.all(entryPromises);
          totalEntries = entryCounts.reduce((sum, count) => sum + count, 0);
        } catch (e) {
          console.log('Error fetching entry counts:', e.message);
        }
      }

      // Fetch prize values (USD) for all completed contests
      // Cap per-contest prize at $1M to filter corrupted price data
      const MAX_PRIZE_USD = 1_000_000;
      let totalPrizeUSD = 0;
      if (kvClient && stats.completedContestIds.length > 0) {
        try {
          const prizePromises = stats.completedContestIds.map(async (c) => {
            let usd = 0;
            // ETH contests (type 0): check KV cache first, fallback to on-chain calc
            if (c.contestType === 0) {
              const cached = await kvClient.get(`contest_price_prize_${c.id}`).catch(() => null);
              if (cached?.prizeValueUSD) return Math.min(cached.prizeValueUSD, MAX_PRIZE_USD);
              const ethAmount = Number(ethers.formatEther(c.prizeAmount));
              usd = ethAmount > 0 ? ethAmount * ethPriceUSD : 0;
              return Math.min(usd, MAX_PRIZE_USD);
            }
            // ERC20 token contests (type 1): lookup stored price, fallback to live price
            if (c.contestType === 1) {
              const priceData = await kvClient.get(`contest_price_prize_${c.id}`).catch(() => null);
              if (priceData?.adminOverride) return Math.min(priceData.prizeValueUSD || 0, MAX_PRIZE_USD);
              if (priceData?.prizeValueUSD && priceData.prizeValueUSD >= 0.01) return Math.min(priceData.prizeValueUSD, MAX_PRIZE_USD);
              // Fallback: calculate from on-chain token price
              if (c.prizeToken && c.prizeToken !== ethers.ZeroAddress) {
                try {
                  const tokenPrice = await getTokenPriceUSD(provider, c.prizeToken);
                  if (tokenPrice > 0) {
                    const tokenContract = new ethers.Contract(c.prizeToken, ['function decimals() view returns (uint8)'], provider);
                    const decimals = await tokenContract.decimals().catch(() => 18n);
                    const amount = Number(ethers.formatUnits(c.prizeAmount, Number(decimals)));
                    usd = amount * tokenPrice;
                    // Cache for future lookups
                    await kvClient.set(`contest_price_prize_${c.id}`, { prizeValueUSD: usd }).catch(() => {});
                    return Math.min(usd, MAX_PRIZE_USD);
                  }
                } catch (e) {
                  console.log(`Error getting ERC20 price for ${c.id}:`, e.message);
                }
              }
              return 0;
            }
            // NFT contests (type 2, 3): lookup stored floor price
            if (c.contestType === 2 || c.contestType === 3) {
              const nftData = await kvClient.get(`nft_price_${c.id}`).catch(() => null);
              return Math.min(nftData?.floorPriceUSD || 0, MAX_PRIZE_USD);
            }
            return 0;
          });
          const prizeValues = await Promise.all(prizePromises);
          totalPrizeUSD = prizeValues.reduce((sum, val) => sum + val, 0);
        } catch (e) {
          console.log('Error fetching prize values:', e.message);
        }
      }

      // Fetch votes and token holdings
      const holdingsAddresses = [...new Set([stats.address, ...(userInfo?.verifiedAddresses || [])])];
      const [votesResult, tokenHoldings] = await Promise.all([
        votingContract.getHostVotes(stats.address).catch(() => [0n, 0n]),
        getTokenHoldings(holdingsAddresses, tokenContract, kvClient)
      ]);

      const [upvotes, downvotes] = votesResult;
      stats.upvotes = Number(upvotes);
      stats.downvotes = Number(downvotes);

      // SCORING SYSTEM:
      // - Entry Score: 100 points per contest entry
      // - Vote Score: 100 points per net vote (upvotes - downvotes)
      // - Token Score: 10 points per 1,000,000 NEYNARTODES held
      // - Prize Score: 500 points per $1 USD given away in completed contests
      const entryScore = totalEntries * 100;
      const voteScore = (stats.upvotes - stats.downvotes) * 100;
      const tokenScore = Math.floor(tokenHoldings / 1000000) * 10;
      const prizeScore = Math.floor(totalPrizeUSD * 500);
      const totalScore = entryScore + voteScore + tokenScore + prizeScore;

      hostsWithScores.push({
        address: stats.address,
        fid: hostFid,
        username: userInfo?.username || stats.address.slice(0, 8),
        displayName: userInfo?.displayName || 'Unknown',
        pfpUrl: userInfo?.pfpUrl || '',
        neynarScore: Math.round((userInfo?.neynarScore || 0) * 100) / 100,
        contests: stats.contests,
        completedContests: stats.completedContests,
        totalEntries,
        tokenHoldings,
        totalPrizeUSD: Math.round(totalPrizeUSD * 100) / 100,
        upvotes: stats.upvotes,
        downvotes: stats.downvotes,
        entryScore,
        tokenScore,
        voteScore,
        prizeScore,
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
        total: 'Entry Score + Vote Score + Token Score + Prize Score',
        entry: '100 points per contest entry received',
        vote: '100 points per net vote (upvotes - downvotes)',
        token: '10 points per 1,000,000 NEYNARTODES held',
        prize: '500 points per $1 USD given away in completed contests',
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
