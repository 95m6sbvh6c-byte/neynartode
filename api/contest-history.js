/**
 * Contest History API
 *
 * Fetches contests from the unified ContestManager contract (M- and T- prefix contests).
 * OPTIMIZED: Uses KV caching for contests, cached getUserByWallet, and HTTP cache headers
 *
 * Cache Strategy:
 *   - Completed/Cancelled contests: 7 days TTL (final state, won't change)
 *   - Active/Pending contests: 2 minute TTL (may change)
 *   - Falls back to in-memory cache when KV unavailable
 *
 * Usage:
 *   GET /api/contest-history?limit=20
 *   GET /api/contest-history?host=0x123...  (filter by host)
 *   GET /api/contest-history?status=active  (only active contests)
 *
 * Returns: Array of contest objects with full stats
 */

const { ethers } = require('ethers');
const { getUserByWallet: getCachedUserByWallet } = require('./lib/utils');

const CONFIG = {
  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Unified ContestManager ABI (M- and T- prefix contests)
const UNIFIED_CONTEST_MANAGER_ABI = [
  'function getContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
  'function getTestContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

// Prize types
const PRIZE_TYPES = {
  0: 'ETH',
  1: 'ERC20',
  2: 'ERC721',
  3: 'ERC1155'
};

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 id) view returns (string)',
  'function name() view returns (string)',
];

const STATUS_MAP = {
  0: 'Active',
  1: 'PendingVRF',
  2: 'Completed',
  3: 'Cancelled'
};

/**
 * Get Farcaster user info by wallet address
 */
async function getUserByWallet(walletAddress) {
  try {
    const user = await getCachedUserByWallet(walletAddress);
    if (!user) return null;
    return {
      fid: user.fid,
      username: user.username,
      displayName: user.display_name,
      pfpUrl: user.pfp_url,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Get NFT metadata (name, image)
 */
async function getNftMetadata(provider, nftContract, tokenId, nftType) {
  try {
    const nftContractInstance = new ethers.Contract(nftContract, NFT_ABI, provider);

    let collectionName = 'NFT Collection';
    try {
      collectionName = await nftContractInstance.name();
    } catch (e) {}

    let tokenUri = '';
    try {
      if (nftType === 1) {
        tokenUri = await nftContractInstance.uri(tokenId);
        tokenUri = tokenUri.replace('{id}', tokenId.toString().padStart(64, '0'));
      } else {
        tokenUri = await nftContractInstance.tokenURI(tokenId);
      }
    } catch (e) {
      return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
    }

    let metadataUrl = tokenUri;
    if (tokenUri.startsWith('ipfs://')) {
      metadataUrl = tokenUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    } else if (tokenUri.startsWith('ar://')) {
      metadataUrl = tokenUri.replace('ar://', 'https://arweave.net/');
    } else if (tokenUri.startsWith('data:application/json')) {
      try {
        const base64Data = tokenUri.split(',')[1];
        const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
        const metadata = JSON.parse(jsonStr);
        let imageUrl = metadata.image || '';
        if (imageUrl.startsWith('ipfs://')) {
          imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
        return {
          name: metadata.name || `${collectionName} #${tokenId}`,
          image: imageUrl,
          collection: collectionName
        };
      } catch (e) {
        return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
      }
    }

    try {
      const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const metadata = await response.json();
        let imageUrl = metadata.image || '';
        if (imageUrl.startsWith('ipfs://')) {
          imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
        return {
          name: metadata.name || `${collectionName} #${tokenId}`,
          image: imageUrl,
          collection: collectionName
        };
      }
    } catch (e) {}

    return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
  } catch (e) {
    return { name: `NFT #${tokenId}`, image: '', collection: '' };
  }
}

// Known tokens cache
const KNOWN_TOKENS = {
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18, name: 'Ether' },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  '0x8de1622fe07f56cda2e2273e615a513f1d828b07': { symbol: 'NEYNARTODES', decimals: 18, name: 'Neynartodes' },
};

const tokenInfoCache = new Map();

/**
 * Get token info (symbol, decimals, name)
 */
async function getTokenInfo(provider, tokenAddress) {
  if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
    return { symbol: 'ETH', decimals: 18, name: 'Ether' };
  }

  const addrLower = tokenAddress.toLowerCase();
  if (KNOWN_TOKENS[addrLower]) {
    return KNOWN_TOKENS[addrLower];
  }

  if (tokenInfoCache.has(addrLower)) {
    return tokenInfoCache.get(addrLower);
  }

  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([
      token.symbol().catch(() => 'UNKNOWN'),
      token.decimals().catch(() => 18),
      token.name().catch(() => 'Unknown Token'),
    ]);
    const info = { symbol, decimals: Number(decimals), name };
    tokenInfoCache.set(addrLower, info);
    return info;
  } catch (e) {
    const info = { symbol: 'UNKNOWN', decimals: 18, name: 'Unknown Token' };
    tokenInfoCache.set(addrLower, info);
    return info;
  }
}

/**
 * Get cached contest from KV
 */
async function getCachedContest(cacheKey) {
  if (!process.env.KV_REST_API_URL) return null;
  try {
    const { kv } = await import('@vercel/kv');
    return await kv.get(cacheKey);
  } catch (e) {
    return null;
  }
}

/**
 * Cache contest in KV
 */
async function setCachedContest(cacheKey, contest) {
  if (!process.env.KV_REST_API_URL) return;
  try {
    const { kv } = await import('@vercel/kv');
    const ttl = contest.status >= 2 ? 60 * 60 * 24 * 7 : 60 * 2;
    await kv.set(cacheKey, contest, { ex: ttl });
  } catch (e) {}
}

/**
 * Fetch contest details from unified ContestManager
 */
async function getContestDetails(provider, contract, contestId, isTest = false) {
  const prefix = isTest ? 'T' : 'M';
  const cacheKey = `contest:unified:${prefix}-${contestId}`;

  const cached = await getCachedContest(cacheKey);
  if (cached) return cached;

  try {
    const contestData = isTest
      ? await contract.getTestContest(contestId)
      : await contract.getContest(contestId);

    const {
      host, prizeType, prizeToken, prizeAmount, nftContract, nftTokenId, nftAmount,
      startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winnerCount, winners
    } = contestData;

    const prizeTypeNum = Number(prizeType);
    const isNft = prizeTypeNum === 2 || prizeTypeNum === 3;
    const isEth = prizeTypeNum === 0;

    let prizeTokenInfo = { symbol: 'ETH', decimals: 18, name: 'Ether' };
    if (!isNft && !isEth && prizeToken !== '0x0000000000000000000000000000000000000000') {
      prizeTokenInfo = await getTokenInfo(provider, prizeToken);
    }

    const formattedPrize = Number(prizeAmount) / Math.pow(10, prizeTokenInfo.decimals);

    let tokenRequirementSymbol = null;
    if (tokenRequirement !== '0x0000000000000000000000000000000000000000') {
      const reqTokenInfo = await getTokenInfo(provider, tokenRequirement);
      tokenRequirementSymbol = reqTokenInfo.symbol;
    }

    const castParts = castId.split('|');
    const actualCastHash = castParts[0];

    let requireRecast = false, requireLike = false, requireReply = false;
    if (castParts[1]) {
      const reqCode = castParts[1];
      const recastMatch = reqCode.match(/R(\d)/);
      const likeMatch = reqCode.match(/L(\d)/);
      const replyMatch = reqCode.match(/P(\d)/);
      if (recastMatch) requireRecast = recastMatch[1] !== '0';
      if (likeMatch) requireLike = likeMatch[1] !== '0';
      if (replyMatch) requireReply = replyMatch[1] !== '0';
    }

    let nftImage = '';
    let nftName = '';
    if (isNft && castParts[2]) {
      nftImage = castParts[2];
    }
    if (isNft && nftContract !== '0x0000000000000000000000000000000000000000') {
      try {
        const nftType = prizeTypeNum === 2 ? 0 : 1;
        const metadata = await getNftMetadata(provider, nftContract, nftTokenId, nftType);
        nftName = metadata.name || `NFT #${nftTokenId}`;
        if (!nftImage && metadata.image) nftImage = metadata.image;
      } catch (e) {
        nftName = `NFT #${nftTokenId}`;
      }
    }

    const durationSeconds = Number(endTime) - Number(startTime);
    const durationHours = Math.floor(durationSeconds / 3600);
    const durationMinutes = Math.floor((durationSeconds % 3600) / 60);

    const contest = {
      contestId: `${prefix}-${contestId}`,
      contestIdNumeric: Number(contestId),
      host,
      prizeToken,
      prizeTokenSymbol: prizeTokenInfo.symbol,
      prizeTokenName: prizeTokenInfo.name,
      prizeAmount: formattedPrize,
      prizeAmountRaw: prizeAmount.toString(),
      startTime: Number(startTime),
      endTime: Number(endTime),
      durationHours,
      durationMinutes,
      castId: actualCastHash,
      tokenRequirement,
      tokenRequirementSymbol,
      volumeRequirement: Number(volumeRequirement) / 1e18,
      status: Number(status),
      statusText: STATUS_MAP[Number(status)] || 'Unknown',
      winner: winners.length > 0 ? winners[0] : '0x0000000000000000000000000000000000000000',
      winners,
      winnerCount: Number(winnerCount),
      participantCount: 0,
      qualifiedEntries: [],
      requireRecast,
      requireLike,
      requireReply,
      isNft,
      nftAddress: isNft ? nftContract : '',
      nftTokenId: isNft ? nftTokenId.toString() : '',
      nftAmount: isNft ? Number(nftAmount) : 0,
      nftImage,
      nftName,
      nftCollection: '',
      nftType: prizeTypeNum === 2 ? 'ERC721' : (prizeTypeNum === 3 ? 'ERC1155' : ''),
      contestType: PRIZE_TYPES[prizeTypeNum] || 'Unknown',
      isUnified: true,
      isTest,
    };

    await setCachedContest(cacheKey, contest);
    return contest;
  } catch (e) {
    console.error(`Error fetching contest ${prefix}-${contestId}:`, e.message);
    return null;
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

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300, max-age=30');

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contract = new ethers.Contract(CONFIG.CONTEST_MANAGER, UNIFIED_CONTEST_MANAGER_ABI, provider);

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const hostFilter = req.query.host?.toLowerCase();
    const includeUsers = req.query.includeUsers !== 'false';
    const statusFilter = req.query.status || 'history';

    // Fetch contest counts
    const mainNextId = await contract.mainNextContestId().catch(() => 1);
    const testNextId = await contract.testNextContestId().catch(() => 1);

    const totalMainContests = Number(mainNextId) - 1;
    const totalTestContests = Number(testNextId) - 1;
    const totalContests = totalMainContests + totalTestContests;

    console.log(`Contest counts: M-=${totalMainContests}, T-=${totalTestContests}`);

    if (totalContests <= 0) {
      return res.status(200).json({ contests: [], total: 0, fetched: 0 });
    }

    // Fetch all contests
    const contestPromises = [];

    for (let i = totalMainContests; i >= 1; i--) {
      contestPromises.push(getContestDetails(provider, contract, i, false));
    }
    for (let i = totalTestContests; i >= 1; i--) {
      contestPromises.push(getContestDetails(provider, contract, i, true));
    }

    const allContests = (await Promise.all(contestPromises)).filter(c => c !== null);

    // Sort by endTime descending
    allContests.sort((a, b) => b.endTime - a.endTime);

    // Apply status filter
    let filteredContests = allContests;
    const nowTimestamp = Math.floor(Date.now() / 1000);
    if (statusFilter === 'active') {
      filteredContests = allContests.filter(c => (c.status === 0 || c.status === 1) && c.endTime > nowTimestamp);
    } else if (statusFilter === 'history') {
      filteredContests = allContests.filter(c => c.status === 2 || c.status === 3);
    }

    if (hostFilter) {
      filteredContests = filteredContests.filter(c => c.host.toLowerCase() === hostFilter);
    }

    const limitedContests = filteredContests.slice(0, limit);

    // Fetch user info
    if (includeUsers && limitedContests.length > 0) {
      const addressesToLookup = new Set();
      limitedContests.forEach(contest => {
        addressesToLookup.add(contest.host.toLowerCase());
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          addressesToLookup.add(contest.winner.toLowerCase());
        }
        if (contest.winners?.length > 0) {
          contest.winners.forEach(w => {
            if (w !== '0x0000000000000000000000000000000000000000') {
              addressesToLookup.add(w.toLowerCase());
            }
          });
        }
      });

      const userPromises = Array.from(addressesToLookup).map(addr =>
        getUserByWallet(addr).then(user => ({ addr, user })).catch(() => ({ addr, user: null }))
      );
      const userResults = await Promise.all(userPromises);

      const userMap = {};
      userResults.forEach(({ addr, user }) => { userMap[addr] = user; });

      limitedContests.forEach(contest => {
        contest.hostUser = userMap[contest.host.toLowerCase()] || null;
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          contest.winnerUser = userMap[contest.winner.toLowerCase()] || null;
        }
        if (contest.winners?.length > 0) {
          contest.winnerUsers = contest.winners
            .filter(w => w !== '0x0000000000000000000000000000000000000000')
            .map(w => userMap[w.toLowerCase()] || null);
        }
      });
    }

    // Fetch participant counts from KV
    if (process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');
        const participantPromises = limitedContests.map(async (contest) => {
          const count = await kv.scard(`contest_entries:${contest.contestId}`).catch(() => 0);
          return { contestId: contest.contestId, count };
        });
        const participantCounts = await Promise.all(participantPromises);
        participantCounts.forEach(({ contestId, count }) => {
          const contest = limitedContests.find(c => c.contestId === contestId);
          if (contest) contest.participantCount = count;
        });
      } catch (e) {}
    }

    return res.status(200).json({
      contests: limitedContests,
      total: totalContests,
      totalMain: totalMainContests,
      totalTest: totalTestContests,
      fetched: limitedContests.length,
      limit,
    });

  } catch (e) {
    console.error('Contest history error:', e);
    return res.status(500).json({ error: e.message });
  }
};
