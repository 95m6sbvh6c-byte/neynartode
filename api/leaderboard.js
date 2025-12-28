/**
 * Host Leaderboard API
 *
 * Fetches all completed contests, aggregates host stats, and calculates scores.
 * Now season-aware - filters contests by season time range.
 *
 * OPTIMIZED: Uses KV caching + in-memory caching to reduce Neynar API calls
 *
 * Scoring System:
 *   Total Score = Contest Score + Vote Score
 *   Contest Score = Host Bonus + (Social x Contests) + Token
 *   Host Bonus = 100 points per completed contest
 *   Social Multiplier = Social Score x completed contests (rewards active hosts)
 *   Vote Score = (Upvotes - Downvotes) x 200
 *   Social = (Likes x 1 + Recasts x 2 + Replies x 3) x 100
 *   Token = Token Holdings / 50,000
 *
 * Usage:
 *   GET /api/leaderboard?limit=10&season=2
 */

const { ethers } = require('ethers');
const { getUserByWallet: getCachedUserByWallet, getCached, setCache } = require('./lib/utils');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  CONTEST_MANAGER_V2: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06', // Deployed 2025-12-17
  V2_START_ID: 105, // V2 contests start at ID 105
  PRIZE_NFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  VOTING_MANAGER: '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  CURRENT_SEASON: 2, // Default active season
};

// Excluded from leaderboard and season prizes (devs/admins who shouldn't compete)
const EXCLUDED_FIDS = [
  1188162, // cb91waverider (project owner)
];

const EXCLUDED_ADDRESSES = [
  '0x78eeaa6f014667a339fcf8b4ecd74743366603fb', // Dev wallet
  '0x6b814f71712ad9e5b2299676490ce530797f9ec7', // cb91waverider custody
  '0xab4f21321a7a16eb57171994c7d7d1c808506e5d', // cb91waverider verified
  '0x64cb30c6d5e1dc5e675296cf13d547150c71c2b1', // cb91waverider verified
];

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function nextContestId() external view returns (uint256)',
];

const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
  'function nextContestId() external view returns (uint256)',
];

const PRIZE_NFT_ABI = [
  'function seasons(uint256) external view returns (string theme, uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
];

const VOTING_MANAGER_ABI = [
  'function getHostVotes(address host) external view returns (uint256 upvotes, uint256 downvotes)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Get Farcaster user info by wallet address (uses cached version from utils)
 */
async function getUserByWallet(walletAddress) {
  try {
    const user = await getCachedUserByWallet(walletAddress);
    if (!user) return null;

    // Get all verified addresses for this user
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

/**
 * Get total NEYNARTODES token holdings across all addresses
 * Uses KV cache (1 hour TTL) + retry logic for chain calls
 */
async function getTokenHoldings(addresses, tokenContract, kvClient = null) {
  let totalBalance = 0n;
  let cacheHits = 0;

  for (const addr of addresses) {
    const addrLower = addr.toLowerCase();
    const kvCacheKey = `holdings:${addrLower}`;

    // Check KV cache first (1 hour TTL)
    if (kvClient) {
      try {
        const cached = await kvClient.get(kvCacheKey);
        if (cached && cached.balance !== undefined) {
          // Check if cache is still valid (1 hour = 3600000ms)
          if (Date.now() - cached.updatedAt < 3600000) {
            totalBalance += BigInt(cached.balance);
            cacheHits++;
            continue;
          }
        }
      } catch (e) {
        // Cache miss or error, fetch from chain
      }
    }

    // Fetch from chain with retry logic
    let balance = 0n;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        balance = await tokenContract.balanceOf(addr);
        totalBalance += BigInt(balance);

        // Cache the result in KV (1 hour TTL)
        if (kvClient) {
          try {
            await kvClient.set(kvCacheKey, {
              balance: balance.toString(),
              updatedAt: Date.now(),
            }, { ex: 3600 }); // 1 hour expiry
          } catch (e) {
            // Ignore cache errors
          }
        }
        break; // Success, exit retry loop
      } catch (e) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        }
        // On final failure, just continue with 0 for this address
      }
    }
  }

  // Convert from wei (18 decimals) to whole tokens
  return Number(totalBalance / 10n**18n);
}

/**
 * Get cast engagement metrics (CACHED with KV + in-memory)
 * Checks KV season cache first, then falls back to Neynar API
 *
 * @param {object} contestInfo - { castHash, type, id } - Contest info for cache lookup
 * @param {number} hostFid - The host's Farcaster ID (to verify authorship)
 * @param {object} kv - Vercel KV instance (optional, for season cache)
 */
async function getCastEngagement(contestInfo, hostFid, kv = null) {
  const { castHash, type, id } = contestInfo;

  if (!castHash || castHash === '' || castHash.includes('|')) {
    return { likes: 0, recasts: 0, replies: 0, isAuthor: false };
  }

  // Clean the cast hash - remove any prefix
  const cleanHash = castHash.startsWith('0x') ? castHash : `0x${castHash}`;

  // Check in-memory cache first (5 min TTL for cast engagement)
  const memoryCacheKey = `cast:engagement:${cleanHash}:${hostFid}`;
  const cached = getCached(memoryCacheKey, 300000);
  if (cached !== null) return cached;

  // Check KV season cache if available (permanent cache from finalization)
  if (kv && type && id) {
    try {
      const kvCacheKey = `contest:social:${type}-${id}`;
      const kvCached = await kv.get(kvCacheKey);

      if (kvCached) {
        // KV cache data was validated at storage time (finalization/backfill)
        // The castId stored on-chain is the host's cast, so we trust the cached data
        // Only verify hostFid if BOTH fids are available and non-zero
        if (hostFid && kvCached.hostFid && kvCached.hostFid !== hostFid) {
          // FIDs don't match - this shouldn't happen, log for debugging
          console.log(`   KV cache hostFid mismatch: cached=${kvCached.hostFid}, lookup=${hostFid}, contest=${type}-${id}`);
          const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
          setCache(memoryCacheKey, result, 300000);
          return result;
        }

        // Use cached data - either FIDs match, or we can't verify (trust cache)
        const result = {
          likes: kvCached.likes || 0,
          recasts: kvCached.recasts || 0,
          replies: kvCached.replies || 0,
          isAuthor: true,
          fromKVCache: true, // Mark as from KV for debugging
        };
        setCache(memoryCacheKey, result, 300000);
        return result;
      }
    } catch (e) {
      // KV cache miss or error, fall through to Neynar API
    }
  }

  // Fall back to Neynar API
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${cleanHash}&type=hash`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) {
      const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
      setCache(memoryCacheKey, result, 60000); // Cache failures for 1 min
      return result;
    }

    const data = await response.json();
    const cast = data.cast;

    if (!cast) {
      const result = { likes: 0, recasts: 0, replies: 0, isAuthor: false };
      setCache(memoryCacheKey, result, 60000);
      return result;
    }

    // Check if the host is the original author of this cast
    const authorFid = cast.author?.fid;
    const isAuthor = hostFid && authorFid && authorFid === hostFid;

    // Only count engagement if host authored the cast
    if (!isAuthor) {
      console.log(`   Cast ${cleanHash.slice(0, 10)}... authored by FID ${authorFid}, not host FID ${hostFid} - skipping engagement`);
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
    setCache(memoryCacheKey, result, 300000); // Cache for 5 min

    // Store in KV cache for future requests (if KV available and we have contest info)
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
          backfilled: true, // Mark as backfilled from leaderboard
        });
      } catch (e) {
        // Ignore KV errors, non-fatal
      }
    }

    return result;
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

  // Add HTTP cache headers (cache for 5 minutes on CDN, 1 minute in browser)
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600, max-age=60');

  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const seasonId = parseInt(req.query.season) || CONFIG.CURRENT_SEASON;

  // Check KV cache first (5 min TTL)
  const kvCacheKey = `leaderboard:s${seasonId}:l${limit}`;
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      const cached = await kv.get(kvCacheKey);
      if (cached) {
        console.log(`Returning cached leaderboard for season ${seasonId}`);
        return res.status(200).json(cached);
      }
    } catch (e) {
      console.log('KV cache check failed:', e.message);
    }
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contestContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContestContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    const contestManagerV2 = new ethers.Contract(CONFIG.CONTEST_MANAGER_V2, CONTEST_MANAGER_V2_ABI, provider);
    const prizeNFTContract = new ethers.Contract(CONFIG.PRIZE_NFT, PRIZE_NFT_ABI, provider);
    const votingContract = new ethers.Contract(CONFIG.VOTING_MANAGER, VOTING_MANAGER_ABI, provider);
    const tokenContract = new ethers.Contract(CONFIG.NEYNARTODES_TOKEN, ERC20_ABI, provider);

    // Initialize KV for season caching (used by getCastEngagement)
    let kvClient = null;
    if (process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        kvClient = kv;
      } catch (e) {
        console.log('KV init failed:', e.message);
      }
    }

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

    // Get total contest count from ALL THREE contracts
    const nextContestId = await contestContract.nextContestId();
    const totalLegacyTokenContests = Number(nextContestId) - 1;

    // Get NFT contest count
    let totalNftContests = 0;
    try {
      const nextNftContestId = await nftContestContract.nextContestId();
      totalNftContests = Number(nextNftContestId) - 1;
      console.log(`NFT contests: ${totalNftContests}`);
    } catch (e) {
      console.log('Could not fetch NFT contest count:', e.message);
    }

    let nextV2ContestId = CONFIG.V2_START_ID;
    try {
      nextV2ContestId = Number(await contestManagerV2.nextContestId());
    } catch (e) {
      console.log('Could not fetch V2 contest count:', e.message);
    }
    const totalV2Contests = nextV2ContestId - CONFIG.V2_START_ID;
    const totalContests = totalLegacyTokenContests + totalNftContests + totalV2Contests;
    console.log(`Total contests: ${totalContests} (Token: ${totalLegacyTokenContests}, NFT: ${totalNftContests}, V2: ${totalV2Contests})`);

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

    // ═══════════════════════════════════════════════════════════════════
    // KV-FIRST APPROACH: Read from season index in KV storage
    // This ensures we only count contests that were properly indexed
    // ═══════════════════════════════════════════════════════════════════

    let useKVIndex = false;
    let kvContestKeys = [];

    if (kvClient) {
      try {
        const indexKey = `season:${seasonId}:contests`;
        kvContestKeys = await kvClient.zrange(indexKey, 0, -1) || [];
        if (kvContestKeys.length > 0) {
          useKVIndex = true;
          console.log(`Using KV season index: ${kvContestKeys.length} contests in season ${seasonId}`);
        } else {
          console.log(`KV season index empty, falling back to blockchain scan`);
        }
      } catch (e) {
        console.log(`KV index read failed: ${e.message}, falling back to blockchain scan`);
      }
    }

    const BATCH_SIZE = 15;
    const BATCH_DELAY = 350;

    if (useKVIndex) {
      // ═══════════════════════════════════════════════════════════════════
      // KV-BASED PROCESSING: Only fetch contests that are in the season index
      // ═══════════════════════════════════════════════════════════════════

      // Group contests by type for efficient batching
      const tokenContests = [];
      const nftContests = [];
      const v2Contests = [];

      for (const key of kvContestKeys) {
        const [type, idStr] = key.split('-');
        const id = parseInt(idStr);
        if (type === 'token') tokenContests.push(id);
        else if (type === 'nft') nftContests.push(id);
        else if (type === 'v2') v2Contests.push(id);
      }

      console.log(`Season ${seasonId} breakdown: token=${tokenContests.length}, nft=${nftContests.length}, v2=${v2Contests.length}`);

      // Process token contests from KV index
      for (let i = 0; i < tokenContests.length; i += BATCH_SIZE) {
        const batch = tokenContests.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          contestContract.getContest(id).catch(() => null)
        );
        const socialPromises = batch.map(id =>
          kvClient.get(`contest:social:token-${id}`).catch(() => null)
        );

        const [contestResults, socialResults] = await Promise.all([
          Promise.all(contestPromises),
          Promise.all(socialPromises)
        ]);

        if (i + BATCH_SIZE < tokenContests.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          const socialData = socialResults[j];
          if (!contestData) continue;

          const [host, , , , , castId, , , status] = contestData;
          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            // Use social data from KV cache directly
            if (socialData) {
              hostStats[hostLower].totalLikes += socialData.likes || 0;
              hostStats[hostLower].totalRecasts += socialData.recasts || 0;
              hostStats[hostLower].totalReplies += socialData.replies || 0;
            }

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'token',
                id: batch[j],
                socialFromKV: !!socialData,
              });
            }
          }
        }
      }

      // Process NFT contests from KV index
      for (let i = 0; i < nftContests.length; i += BATCH_SIZE) {
        const batch = nftContests.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          nftContestContract.getContest(id).catch(() => null)
        );
        const socialPromises = batch.map(id =>
          kvClient.get(`contest:social:nft-${id}`).catch(() => null)
        );

        const [contestResults, socialResults] = await Promise.all([
          Promise.all(contestPromises),
          Promise.all(socialPromises)
        ]);

        if (i + BATCH_SIZE < nftContests.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          const socialData = socialResults[j];
          if (!contestData) continue;

          const [host, , , , , , , castId, , , status] = contestData;
          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            if (socialData) {
              hostStats[hostLower].totalLikes += socialData.likes || 0;
              hostStats[hostLower].totalRecasts += socialData.recasts || 0;
              hostStats[hostLower].totalReplies += socialData.replies || 0;
            }

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'nft',
                id: batch[j],
                socialFromKV: !!socialData,
              });
            }
          }
        }
      }

      // Process V2 contests from KV index
      for (let i = 0; i < v2Contests.length; i += BATCH_SIZE) {
        const batch = v2Contests.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          contestManagerV2.getContest(id).catch(() => null)
        );
        const socialPromises = batch.map(id =>
          kvClient.get(`contest:social:v2-${id}`).catch(() => null)
        );

        const [contestResults, socialResults] = await Promise.all([
          Promise.all(contestPromises),
          Promise.all(socialPromises)
        ]);

        if (i + BATCH_SIZE < v2Contests.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          const socialData = socialResults[j];
          if (!contestData) continue;

          const [host, , status, castId] = contestData;
          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            if (socialData) {
              hostStats[hostLower].totalLikes += socialData.likes || 0;
              hostStats[hostLower].totalRecasts += socialData.recasts || 0;
              hostStats[hostLower].totalReplies += socialData.replies || 0;
            }

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'v2',
                id: batch[j],
                socialFromKV: !!socialData,
              });
            }
          }
        }
      }

      console.log(`KV-based processing complete: ${seasonContestCount} contests, ${Object.keys(hostStats).length} unique hosts`);

    } else {
      // ═══════════════════════════════════════════════════════════════════
      // FALLBACK: Original blockchain-based processing (when KV unavailable)
      // ═══════════════════════════════════════════════════════════════════

      // Process LEGACY TOKEN contests (IDs 1 to totalLegacyTokenContests)
      const legacyContestIds = Array.from({ length: totalLegacyTokenContests }, (_, i) => i + 1);

      for (let i = 0; i < legacyContestIds.length; i += BATCH_SIZE) {
        const batch = legacyContestIds.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          contestContract.getContest(id).catch(() => null)
        );

        const contestResults = await Promise.all(contestPromises);

        if (i + BATCH_SIZE < legacyContestIds.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          if (!contestData) continue;

          const [host, , , , endTime, castId, , volumeRequirement, status] = contestData;
          const contestEndTime = Number(endTime);

          if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
            continue;
          }

          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'token',
                id: batch[j],
              });
            }

            const volume = Number(volumeRequirement) / 1e18;
            hostStats[hostLower].totalVolume += volume;
          }
        }
      }

      // Process NFT CONTESTS (IDs 1 to totalNftContests)
      const nftContestIds = Array.from({ length: totalNftContests }, (_, i) => i + 1);

      for (let i = 0; i < nftContestIds.length; i += BATCH_SIZE) {
        const batch = nftContestIds.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          nftContestContract.getContest(id).catch(() => null)
        );

        const contestResults = await Promise.all(contestPromises);

        if (i + BATCH_SIZE < nftContestIds.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          if (!contestData) continue;

          const [host, , , , , , endTime, castId, , volumeRequirement, status] = contestData;
          const contestEndTime = Number(endTime);

          if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
            continue;
          }

          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'nft',
                id: batch[j],
              });
            }

            const volume = Number(volumeRequirement) / 1e18;
            hostStats[hostLower].totalVolume += volume;
          }
        }
      }

      // Process V2 contests (IDs V2_START_ID to nextV2ContestId - 1)
      const v2ContestIds = Array.from({ length: totalV2Contests }, (_, i) => CONFIG.V2_START_ID + i);

      for (let i = 0; i < v2ContestIds.length; i += BATCH_SIZE) {
        const batch = v2ContestIds.slice(i, i + BATCH_SIZE);
        const contestPromises = batch.map(id =>
          contestManagerV2.getContest(id).catch(() => null)
        );

        const contestResults = await Promise.all(contestPromises);

        if (i + BATCH_SIZE < v2ContestIds.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }

        for (let j = 0; j < batch.length; j++) {
          const contestData = contestResults[j];
          if (!contestData) continue;

          const [host, , status, castId, endTime] = contestData;
          const contestEndTime = Number(endTime);

          if (contestEndTime < seasonStartTime || contestEndTime > seasonEndTime) {
            continue;
          }

          seasonContestCount++;
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
              totalVolume: 0,
              contestInfos: [],
            };
          }

          hostStats[hostLower].contests++;

          if (Number(status) === 2) {
            hostStats[hostLower].completedContests++;

            const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
            if (actualCastHash && actualCastHash !== '') {
              hostStats[hostLower].contestInfos.push({
                castHash: actualCastHash,
                type: 'v2',
                id: batch[j],
              });
            }
          }
        }
      }
    }

    // Fetch user info, engagement, and votes for all hosts
    // OPTIMIZED: Batch operations where possible
    const hostAddresses = Object.keys(hostStats);
    const hostsWithScores = [];

    // Filter hosts with completed contests
    const activeHosts = hostAddresses.filter(h => hostStats[h].completedContests > 0);

    // STEP 1: Batch fetch all user info in parallel (chunks of 5 to avoid rate limiting)
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

    // STEP 2: Process each host (some operations still sequential due to dependencies)
    for (const hostLower of activeHosts) {
      const stats = hostStats[hostLower];
      const userInfo = userInfoMap.get(hostLower);
      const hostFid = userInfo?.fid || 0;

      // Skip excluded FIDs (double-check for devs/admins)
      if (EXCLUDED_FIDS.includes(hostFid)) {
        continue;
      }

      let ownedCastsCount = 0;
      let kvCacheHits = 0;

      // Check if we already loaded social data from KV in the KV path
      const allSocialFromKV = useKVIndex && stats.contestInfos.every(c => c.socialFromKV);

      if (allSocialFromKV) {
        // Social data was already loaded from KV - just count the contests
        ownedCastsCount = stats.contestInfos.filter(c => c.socialFromKV).length;
        kvCacheHits = ownedCastsCount;
        console.log(`   Host ${userInfo?.username || stats.address.slice(0,8)}: ${ownedCastsCount} contests (all social data from KV)`);
      } else {
        // Fallback: Fetch cast engagements for contests missing KV data
        const contestsNeedingFetch = stats.contestInfos.filter(c => !c.socialFromKV);

        if (contestsNeedingFetch.length > 0) {
          const engagementPromises = contestsNeedingFetch.map(contestInfo =>
            getCastEngagement(contestInfo, hostFid, kvClient)
          );
          const engagements = await Promise.all(engagementPromises);

          engagements.forEach(engagement => {
            if (engagement.isAuthor) {
              stats.totalLikes += engagement.likes;
              stats.totalRecasts += engagement.recasts;
              stats.totalReplies += engagement.replies;
              ownedCastsCount++;
              if (engagement.fromKVCache) kvCacheHits++;
            }
          });
        }

        // Count contests that already had KV data as owned
        const kvContests = stats.contestInfos.filter(c => c.socialFromKV);
        ownedCastsCount += kvContests.length;
        kvCacheHits += kvContests.length;

        console.log(`   Host ${userInfo?.username || stats.address.slice(0,8)}: ${ownedCastsCount}/${stats.contestInfos.length} casts (${kvCacheHits} from KV cache)`);
      }

      // Fetch votes and token holdings in PARALLEL
      // Always include the host address, plus any verified addresses from Farcaster
      const holdingsAddresses = [...new Set([stats.address, ...(userInfo?.verifiedAddresses || [])])];
      const [votesResult, tokenHoldings] = await Promise.all([
        votingContract.getHostVotes(stats.address).catch(() => [0n, 0n]),
        getTokenHoldings(holdingsAddresses, tokenContract, kvClient)
      ]);

      const [upvotes, downvotes] = votesResult;
      stats.upvotes = Number(upvotes);
      stats.downvotes = Number(downvotes);

      // Scoring calculations:
      // Host Bonus = 100 points per completed contest (regardless of cast ownership)
      const hostBonus = stats.completedContests * 100;

      // Social = (Likes x 1 + Recasts x 2 + Replies x 3) x 100 (only from owned casts)
      const socialScore = (stats.totalLikes * 1 + stats.totalRecasts * 2 + stats.totalReplies * 3) * 100;

      // Token = Token Holdings / 50,000
      const tokenScore = Math.floor(tokenHoldings / 50000);

      // Social Multiplier = number of completed contests (rewards active hosts)
      const socialMultiplier = stats.completedContests;

      // Contest Score = Host Bonus + (Social x completedContests) + Token
      const contestScore = hostBonus + (socialScore * socialMultiplier) + tokenScore;

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
        tokenHoldings,
        upvotes: stats.upvotes,
        downvotes: stats.downvotes,
        // Score breakdown
        hostBonus,
        socialScore,
        socialMultiplier,
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

    // Check if #1 leader has changed and send notification
    if (topHosts.length > 0 && process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        const currentLeader = topHosts[0];
        const kvKey = `leaderboard_leader_s${seasonId}`;
        const previousLeaderFid = await kv.get(kvKey);

        // If leader changed (and not first time), send notification
        if (previousLeaderFid && previousLeaderFid !== currentLeader.fid) {
          console.log(`🏆 New #1 leader: ${currentLeader.username} (was FID ${previousLeaderFid})`);

          // Send notification
          const { sendNotification } = require('./send-notification');
          await sendNotification('new_leaderboard_leader', {
            username: currentLeader.username,
            fid: currentLeader.fid,
            score: currentLeader.totalScore,
            season: seasonId,
          });
        }

        // Store current leader
        await kv.set(kvKey, currentLeader.fid);
      } catch (e) {
        console.log('Could not check/update leader:', e.message);
      }
    }

    // Build response
    const response = {
      hosts: topHosts,
      season: seasonInfo,
      seasonContests: seasonContestCount,
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

    // Cache response in KV (5 min TTL)
    if (process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        await kv.set(kvCacheKey, response, { ex: 300 });
        console.log(`Cached leaderboard for season ${seasonId}`);
      } catch (e) {
        console.log('KV cache set failed:', e.message);
      }
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
