/**
 * Contest History API
 *
 * Fetches the last N contests from the ContestEscrow contract with full stats.
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
 *
 * Returns: Array of contest objects with full stats
 */

const { ethers } = require('ethers');
const { getUserByWallet: getCachedUserByWallet } = require('./lib/utils');

const CONFIG = {
  // V1 Contracts (legacy)
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922', // V3 deployed 2025-12-05 (supports restricted NFTs)
  // V2 Contract (new unified system)
  CONTEST_MANAGER_V2: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06', // Deployed 2025-12-17
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

// V3 ABI - note: nftType comes before nftContract in return order
const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

// ContestManager V2 ABI - unified contest manager for ETH/ERC20/NFT contests
const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
  'function getWinners(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

// V2 contest types
const V2_CONTEST_TYPES = {
  0: 'ETH',
  1: 'ERC20',
  2: 'NFT'
};

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

// NFT ABI for direct metadata fetching
const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',  // ERC721
  'function uri(uint256 id) view returns (string)',            // ERC1155
  'function name() view returns (string)',                      // Collection name
];

// Status mapping
const STATUS_MAP = {
  0: 'Active',
  1: 'PendingVRF',
  2: 'Completed',
  3: 'Cancelled'
};

/**
 * Get Farcaster user info by wallet address (uses cached version from utils)
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
 * Get NFT metadata (name, image) - fetches directly from contract tokenURI/uri
 * Uses direct contract calls instead of third-party APIs
 */
async function getNftMetadata(provider, nftContract, tokenId, nftType) {
  try {
    const nftContractInstance = new ethers.Contract(nftContract, NFT_ABI, provider);

    // Get collection name
    let collectionName = 'NFT Collection';
    try {
      collectionName = await nftContractInstance.name();
    } catch (e) {
      // Some contracts don't have name()
    }

    // Get token URI based on NFT type (0 = ERC721, 1 = ERC1155)
    let tokenUri = '';
    try {
      if (nftType === 1) {
        // ERC1155 uses uri()
        tokenUri = await nftContractInstance.uri(tokenId);
        // ERC1155 URIs often have {id} placeholder
        tokenUri = tokenUri.replace('{id}', tokenId.toString().padStart(64, '0'));
      } else {
        // ERC721 uses tokenURI()
        tokenUri = await nftContractInstance.tokenURI(tokenId);
      }
    } catch (e) {
      console.error('Error fetching tokenURI:', e.message);
      return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
    }

    // Handle different URI schemes
    let metadataUrl = tokenUri;
    if (tokenUri.startsWith('ipfs://')) {
      metadataUrl = tokenUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    } else if (tokenUri.startsWith('ar://')) {
      metadataUrl = tokenUri.replace('ar://', 'https://arweave.net/');
    } else if (tokenUri.startsWith('data:application/json')) {
      // Handle base64 encoded JSON
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
          collection: collectionName,
        };
      } catch (e) {
        return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
      }
    }

    // Fetch metadata from URL
    try {
      const response = await fetch(metadataUrl, {
        headers: { 'Accept': 'application/json' },
        timeout: 5000
      });
      if (!response.ok) {
        return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
      }
      const metadata = await response.json();

      let imageUrl = metadata.image || metadata.image_url || '';
      if (imageUrl.startsWith('ipfs://')) {
        imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
      } else if (imageUrl.startsWith('ar://')) {
        imageUrl = imageUrl.replace('ar://', 'https://arweave.net/');
      }

      return {
        name: metadata.name || `${collectionName} #${tokenId}`,
        image: imageUrl,
        collection: collectionName,
      };
    } catch (e) {
      console.error('Error fetching metadata:', e.message);
      return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
    }
  } catch (e) {
    console.error('NFT metadata error:', e.message);
    return { name: `NFT #${tokenId}`, image: '', collection: 'NFT' };
  }
}

// Token info cache to avoid repeated RPC calls
const tokenInfoCache = new Map();

// In-memory contest cache (fallback when KV unavailable)
const contestCache = new Map();
const CONTEST_CACHE_TTL = 60000; // 1 minute for in-memory cache

/**
 * Get cached contest from KV or in-memory cache
 * Completed contests are cached for 1 hour, active contests for 2 minutes
 */
async function getCachedContest(cacheKey) {
  // Try KV first
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      const cached = await kv.get(cacheKey);
      if (cached) return cached;
    } catch (e) {
      // Fall through to in-memory cache
    }
  }

  // Check in-memory cache
  const memCached = contestCache.get(cacheKey);
  if (memCached && Date.now() - memCached.timestamp < CONTEST_CACHE_TTL) {
    return memCached.data;
  }
  return null;
}

/**
 * Set contest in cache (KV and in-memory)
 * Completed/cancelled contests get 1 hour TTL, active get 2 minutes
 */
async function setCachedContest(cacheKey, contest) {
  if (!contest) return;

  // Determine TTL based on status (2=Completed, 3=Cancelled are final)
  const isFinal = contest.status === 2 || contest.status === 3;
  const ttlSeconds = isFinal ? 604800 : 120; // 7 days for final, 2 min for active

  // Save to KV
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      await kv.set(cacheKey, contest, { ex: ttlSeconds });
    } catch (e) {
      // Ignore KV errors, use in-memory fallback
    }
  }

  // Also save to in-memory cache
  contestCache.set(cacheKey, { data: contest, timestamp: Date.now() });
}

// Well-known tokens on Base
const KNOWN_TOKENS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, name: 'USD Coin' },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  '0x8de1622fe07f56cda2e2273e615a513f1d828b07': { symbol: 'NEYNARTODES', decimals: 18, name: 'Neynartodes' },
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18, name: 'Ethereum' },
};

/**
 * Get token info (symbol, decimals, name) - with caching
 */
async function getTokenInfo(provider, tokenAddress) {
  const addrLower = tokenAddress.toLowerCase();

  // Check known tokens first
  if (KNOWN_TOKENS[addrLower]) {
    return KNOWN_TOKENS[addrLower];
  }

  // Check cache
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
 * Fetch full contest details (with caching)
 */
async function getContestDetails(provider, contract, contestId) {
  const cacheKey = `contest:token:${contestId}`;

  // Check cache first
  const cached = await getCachedContest(cacheKey);
  if (cached) return cached;

  try {
    const [contestData, qualifiedEntries] = await Promise.all([
      contract.getContest(contestId),
      contract.getQualifiedEntries(contestId).catch(() => []),
    ]);

    const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contestData;

    // Get token info for prize and requirement tokens
    const [prizeTokenInfo, requirementTokenInfo] = await Promise.all([
      getTokenInfo(provider, prizeToken),
      tokenRequirement !== '0x0000000000000000000000000000000000000000'
        ? getTokenInfo(provider, tokenRequirement)
        : Promise.resolve(null),
    ]);

    // Format prize amount
    const formattedPrize = Number(prizeAmount) / Math.pow(10, prizeTokenInfo.decimals);

    // Format volume requirement (always 18 decimals as stored in wei)
    const formattedVolume = Number(volumeRequirement) / 1e18;

    // Calculate duration
    const durationSeconds = Number(endTime) - Number(startTime);
    const durationHours = Math.floor(durationSeconds / 3600);
    const durationMinutes = Math.floor((durationSeconds % 3600) / 60);

    // Extract actual cast hash and parse requirements suffix if present
    const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

    // Parse social requirements from castId (format: "hash|R1L0P1")
    let requireRecast = false, requireLike = false, requireReply = false;
    if (castId.includes('|')) {
      const reqCode = castId.split('|')[1];
      if (reqCode) {
        const recastMatch = reqCode.match(/R(\d)/);
        const likeMatch = reqCode.match(/L(\d)/);
        const replyMatch = reqCode.match(/P(\d)/);
        if (recastMatch) requireRecast = recastMatch[1] !== '0';
        if (likeMatch) requireLike = likeMatch[1] !== '0';
        if (replyMatch) requireReply = replyMatch[1] !== '0';
      }
    }

    const contest = {
      contestId: Number(contestId),
      host: host,
      prizeToken: prizeToken,
      prizeTokenSymbol: prizeTokenInfo.symbol,
      prizeTokenName: prizeTokenInfo.name,
      prizeAmount: formattedPrize,
      prizeAmountRaw: prizeAmount.toString(),
      startTime: Number(startTime),
      endTime: Number(endTime),
      durationHours,
      durationMinutes,
      castId: actualCastHash,
      tokenRequirement: tokenRequirement,
      tokenRequirementSymbol: requirementTokenInfo?.symbol || null,
      volumeRequirement: formattedVolume,
      status: Number(status),
      statusText: STATUS_MAP[Number(status)] || 'Unknown',
      winner: winner,
      participantCount: qualifiedEntries.length,
      qualifiedEntries: qualifiedEntries,
      // Social requirements
      requireRecast,
      requireLike,
      requireReply,
      // Not an NFT contest
      isNft: false,
    };

    // Cache the result
    await setCachedContest(cacheKey, contest);
    return contest;
  } catch (e) {
    console.error(`Error fetching contest ${contestId}:`, e.message);
    return null;
  }
}

/**
 * Get cached NFT contest data from store-nft-contest API
 * Returns null if not cached
 */
async function getCachedNftContestData(contestId) {
  if (!process.env.KV_REST_API_URL) return null;

  try {
    const { kv } = await import('@vercel/kv');
    const cached = await kv.get(`nft:contest:${contestId}`);
    if (cached) {
      console.log(`NFT contest ${contestId}: Using stored NFT metadata (image, name, collection)`);
      return cached;
    }
  } catch (e) {
    // Fall through to contract fetch
  }
  return null;
}

/**
 * Fetch NFT contest details from NFTContestEscrow (with caching)
 */
async function getNftContestDetails(provider, contract, contestId) {
  const cacheKey = `contest:nft:${contestId}`;

  // Check cache first
  const cached = await getCachedContest(cacheKey);
  if (cached) return cached;

  try {
    const [contestData, qualifiedEntries] = await Promise.all([
      contract.getContest(contestId),
      contract.getQualifiedEntries(contestId).catch(() => []),
    ]);

    // V3 order: nftType comes before nftContract
    const [host, nftType, nftContract, tokenId, amount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contestData;

    // Extract actual cast hash and parse requirements
    // Format: castHash|R1L0P1|imageUrl (image URL is optional but we prefer Alchemy)
    const castParts = castId.split('|');
    const actualCastHash = castParts[0];

    // Convert tokenId to number for display
    const tokenIdNum = Number(tokenId);

    // Try to get NFT metadata from our store-nft-contest cache first (faster, more reliable)
    // Falls back to direct contract calls if not cached
    let nftMetadata;
    const storedNftData = await getCachedNftContestData(contestId);
    if (storedNftData && storedNftData.image) {
      nftMetadata = {
        name: storedNftData.name || `NFT #${tokenIdNum}`,
        image: storedNftData.image,
        collection: storedNftData.collection || 'NFT Collection',
      };
    } else {
      // Fallback to direct contract call for metadata
      nftMetadata = await getNftMetadata(provider, nftContract, tokenIdNum, Number(nftType));
    }

    // Get requirement token info
    const requirementTokenInfo = tokenRequirement !== '0x0000000000000000000000000000000000000000'
      ? await getTokenInfo(provider, tokenRequirement)
      : null;

    // Format volume requirement
    const formattedVolume = Number(volumeRequirement) / 1e18;

    // Calculate duration
    const durationSeconds = Number(endTime) - Number(startTime);
    const durationHours = Math.floor(durationSeconds / 3600);
    const durationMinutes = Math.floor((durationSeconds % 3600) / 60);

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

    // Use Alchemy image (always fetched now)
    const finalNftImage = nftMetadata.image;

    const contest = {
      contestId: Number(contestId),
      host: host,
      // NFT-specific fields
      isNft: true,
      nftAddress: nftContract,
      nftTokenId: Number(tokenId),
      nftAmount: Number(amount),
      nftType: Number(nftType) === 0 ? 'ERC721' : 'ERC1155',
      nftName: nftMetadata.name,
      nftImage: finalNftImage,
      nftCollection: nftMetadata.collection,
      // Token fields (null for NFT contests)
      prizeToken: null,
      prizeTokenSymbol: null,
      prizeTokenName: null,
      prizeAmount: Number(amount),
      prizeAmountRaw: amount.toString(),
      // Common fields
      startTime: Number(startTime),
      endTime: Number(endTime),
      durationHours,
      durationMinutes,
      castId: actualCastHash,
      tokenRequirement: tokenRequirement,
      tokenRequirementSymbol: requirementTokenInfo?.symbol || null,
      volumeRequirement: formattedVolume,
      status: Number(status),
      statusText: STATUS_MAP[Number(status)] || 'Unknown',
      winner: winner,
      participantCount: qualifiedEntries.length,
      qualifiedEntries: qualifiedEntries,
      requireRecast,
      requireLike,
      requireReply,
    };

    // Cache the result
    await setCachedContest(cacheKey, contest);
    return contest;
  } catch (e) {
    console.error(`Error fetching NFT contest ${contestId}:`, e.message);
    return null;
  }
}

/**
 * Fetch V2 ContestManager contest details (with caching)
 * V2 contests support multiple winners and unified ETH/ERC20/NFT prizes
 */
async function getV2ContestDetails(provider, contract, contestId) {
  const cacheKey = `contest:v2:${contestId}`;

  // Check cache first
  const cached = await getCachedContest(cacheKey);
  if (cached) return cached;

  try {
    const contestData = await contract.getContest(contestId);

    const [host, contestType, status, castId, endTime, prizeToken, prizeAmount, winnerCount, winners] = contestData;

    // Get token info for prize
    const prizeTokenInfo = await getTokenInfo(provider, prizeToken);

    // Format prize amount
    const formattedPrize = Number(prizeAmount) / Math.pow(10, prizeTokenInfo.decimals);

    // V2 doesn't store startTime, estimate from endTime (assume 24h contests by default)
    // This is just for display purposes
    const estimatedDurationHours = 24;
    const estimatedStartTime = Number(endTime) - (estimatedDurationHours * 3600);

    // Extract actual cast hash and parse requirements suffix if present
    const castParts = castId.split('|');
    const actualCastHash = castParts[0];

    // Parse social requirements from castId (format: "hash|R1L0P1")
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

    // Determine if this is an NFT contest (contestType 2)
    const isNft = Number(contestType) === 2;

    const contest = {
      contestId: Number(contestId),
      host: host,
      prizeToken: prizeToken,
      prizeTokenSymbol: prizeTokenInfo.symbol,
      prizeTokenName: prizeTokenInfo.name,
      prizeAmount: formattedPrize,
      prizeAmountRaw: prizeAmount.toString(),
      startTime: estimatedStartTime,
      endTime: Number(endTime),
      durationHours: estimatedDurationHours,
      durationMinutes: 0,
      castId: actualCastHash,
      // V2 doesn't have tokenRequirement/volumeRequirement
      tokenRequirement: '0x0000000000000000000000000000000000000000',
      tokenRequirementSymbol: null,
      volumeRequirement: 0,
      status: Number(status),
      statusText: STATUS_MAP[Number(status)] || 'Unknown',
      // V2 supports multiple winners
      winner: winners.length > 0 ? winners[0] : '0x0000000000000000000000000000000000000000',
      winners: winners,
      winnerCount: Number(winnerCount),
      participantCount: 0, // V2 doesn't track qualified entries the same way
      qualifiedEntries: [],
      // Social requirements
      requireRecast,
      requireLike,
      requireReply,
      // Contest type info
      isNft: isNft,
      contestType: V2_CONTEST_TYPES[Number(contestType)] || 'Unknown',
      isV2: true, // Flag to identify V2 contests
    };

    // Cache the result
    await setCachedContest(cacheKey, contest);
    return contest;
  } catch (e) {
    console.error(`Error fetching V2 contest ${contestId}:`, e.message);
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

  // Add HTTP cache headers (cache for 2 minutes on CDN, 30 sec in browser)
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300, max-age=30');

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    // V1 contracts (legacy)
    const tokenContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
    // V2 contract (new unified system)
    const v2Contract = new ethers.Contract(CONFIG.CONTEST_MANAGER_V2, CONTEST_MANAGER_V2_ABI, provider);

    // Parse query params
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Max 50
    const hostFilter = req.query.host?.toLowerCase();
    const includeUsers = req.query.includeUsers !== 'false'; // Default true
    // Status filter: 'active' = only active/pending, 'history' = only completed/cancelled (default), 'all' = everything
    const statusFilter = req.query.status || 'history';

    // ═══════════════════════════════════════════════════════════════════════
    // KV-FIRST APPROACH: For history tab, try to load from KV season index
    // This eliminates blockchain calls for completed contests that are cached
    // ═══════════════════════════════════════════════════════════════════════

    if (statusFilter === 'history' && process.env.KV_REST_API_URL) {
      try {
        const { kv } = await import('@vercel/kv');

        // Get current season (default 2) to check the season index
        const seasonId = 2; // Could be dynamic in future
        const indexKey = `season:${seasonId}:contests`;
        const kvContestKeys = await kv.zrange(indexKey, 0, -1, { rev: true }) || [];

        if (kvContestKeys.length > 0) {
          console.log(`KV-first: Found ${kvContestKeys.length} contests in season ${seasonId} index`);

          // Read full contest details from individual caches
          const cachedContests = [];
          const missingKeys = [];

          for (const contestKey of kvContestKeys) {
            const [type, idStr] = contestKey.split('-');
            const id = parseInt(idStr);

            // Determine cache key based on type
            let cacheKey;
            if (type === 'token') cacheKey = `contest:token:${id}`;
            else if (type === 'nft') cacheKey = `contest:nft:${id}`;
            else if (type === 'v2') cacheKey = `contest:v2:${id}`;
            else continue;

            const cached = await kv.get(cacheKey);
            if (cached) {
              // Add contract type info
              cached.contractType = type;
              if (type === 'nft') cached.contestIdDisplay = `NFT-${id}`;
              else if (type === 'v2') cached.contestIdDisplay = `V2-${id}`;
              cachedContests.push(cached);
            } else {
              missingKeys.push({ type, id });
            }
          }

          console.log(`KV cache: ${cachedContests.length} hit, ${missingKeys.length} miss`);

          // Calculate per-contract counts from season index keys
          let kvTokenCount = 0, kvNftCount = 0, kvV2Count = 0;
          for (const key of kvContestKeys) {
            if (key.startsWith('token-')) kvTokenCount++;
            else if (key.startsWith('nft-')) kvNftCount++;
            else if (key.startsWith('v2-')) kvV2Count++;
          }

          // If we have enough cached contests for the requested limit, use KV-only
          if (cachedContests.length >= limit || missingKeys.length === 0) {
            // Sort by endTime descending
            cachedContests.sort((a, b) => b.endTime - a.endTime);

            // Apply host filter if specified
            let filteredContests = cachedContests;
            if (hostFilter) {
              filteredContests = cachedContests.filter(c => c.host.toLowerCase() === hostFilter);
            }

            // Apply limit
            const limitedContests = filteredContests.slice(0, limit);

            // Fetch user info if requested
            if (includeUsers && limitedContests.length > 0) {
              const addressesToLookup = new Set();
              limitedContests.forEach(contest => {
                addressesToLookup.add(contest.host.toLowerCase());
                if (contest.winner !== '0x0000000000000000000000000000000000000000') {
                  addressesToLookup.add(contest.winner.toLowerCase());
                }
                if (contest.winners && contest.winners.length > 0) {
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
                if (contest.winners && contest.winners.length > 0) {
                  contest.winnerUsers = contest.winners
                    .filter(w => w !== '0x0000000000000000000000000000000000000000')
                    .map(w => userMap[w.toLowerCase()] || null);
                }
              });
            }

            // Fetch participant counts from KV
            const V2_START_ID = 105;
            const participantPromises = limitedContests.map(async (contest) => {
              const contestId = contest.contestId.toString();
              const isV2Contest = contest.contestId >= V2_START_ID;

              let count = 0;
              if (isV2Contest) {
                const v2Count = await kv.scard(`contest_entries:v2-${contestId}`).catch(() => 0);
                const legacyCount = await kv.scard(`contest_entries:${contestId}`).catch(() => 0);
                count = (v2Count || 0) + (legacyCount || 0);
              } else {
                count = await kv.scard(`contest_entries:${contestId}`).catch(() => 0);
              }
              return { contestId: contest.contestId, isV2: contest.isV2, count };
            });
            const participantCounts = await Promise.all(participantPromises);

            participantCounts.forEach(({ contestId, isV2, count }) => {
              const contest = limitedContests.find(c => c.contestId === contestId && c.isV2 === isV2);
              if (contest) contest.participantCount = count;
            });

            // Fetch social data from KV
            const socialPromises = limitedContests.map(async (contest) => {
              if (contest.status !== 2) return { contestId: contest.contestId, contractType: contest.contractType, social: null };

              const cacheKey = `contest:social:${contest.contractType}-${contest.contestId}`;
              try {
                const socialData = await kv.get(cacheKey);
                return { contestId: contest.contestId, contractType: contest.contractType, social: socialData || null };
              } catch (e) {
                return { contestId: contest.contestId, contractType: contest.contractType, social: null };
              }
            });
            const socialResults = await Promise.all(socialPromises);

            socialResults.forEach(({ contestId, contractType, social }) => {
              const contest = limitedContests.find(c => c.contestId === contestId && c.contractType === contractType);
              if (contest && social) {
                contest.likes = social.likes || 0;
                contest.recasts = social.recasts || 0;
                contest.replies = social.replies || 0;
                contest.socialCapturedAt = social.capturedAt || null;
              }
            });

            console.log(`KV-ONLY: Returning ${limitedContests.length} contests (0 blockchain calls)`);

            return res.status(200).json({
              contests: limitedContests,
              total: kvContestKeys.length,
              totalToken: kvTokenCount,
              totalNft: kvNftCount,
              totalV2: kvV2Count,
              fetched: limitedContests.length,
              limit,
              fromKVCache: true,
              debug: {
                kvContestsInIndex: kvContestKeys.length,
                cachedContests: cachedContests.length,
                missingContests: missingKeys.length,
              }
            });
          }

          // If not enough cached, fall through to blockchain fetch
          console.log(`KV cache insufficient (${cachedContests.length} < ${limit}), falling back to blockchain`);
        }
      } catch (e) {
        console.log('KV-first approach failed:', e.message, '- falling back to blockchain');
      }
    }

    // Get total contest counts from all contracts (with retry on rate limit)
    const fetchWithRetry = async (fn, maxRetries = 3) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
          } else {
            throw e;
          }
        }
      }
    };

    // Fetch contest counts sequentially to avoid rate limit
    const tokenNextId = await fetchWithRetry(() => tokenContract.nextContestId());
    await new Promise(r => setTimeout(r, 100));
    const nftNextId = await fetchWithRetry(() => nftContract.nextContestId()).catch(() => 1);
    await new Promise(r => setTimeout(r, 100));
    const v2NextId = await fetchWithRetry(() => v2Contract.nextContestId()).catch(() => 105);
    const totalTokenContests = Number(tokenNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;
    // V2 contests start at ID 105, so highest ID is v2NextId - 1
    const v2HighestId = Number(v2NextId) - 1;
    const V2_START_CONTEST_ID = 105;
    const totalV2Contests = v2HighestId >= V2_START_CONTEST_ID ? v2HighestId - V2_START_CONTEST_ID + 1 : 0;
    const totalContests = totalTokenContests + totalNftContests + totalV2Contests;

    console.log(`Contest counts: token=${totalTokenContests}, nft=${totalNftContests}, v2=${totalV2Contests} (IDs ${V2_START_CONTEST_ID}-${v2HighestId})`);

    if (totalContests <= 0) {
      return res.status(200).json({
        contests: [],
        total: 0,
        fetched: 0,
      });
    }

    // Create LAZY fetch functions (not promises) to control execution timing
    // This prevents all requests from firing at once when promises are created
    // With KV caching, we fetch ALL contests - cached ones return instantly
    const tokenFetchers = [];
    const nftFetchers = [];
    const v2Fetchers = [];

    // Create fetcher functions for ALL V1 token contests (most recent first)
    // Caching makes this efficient - completed contests are cached for 7 days
    for (let i = totalTokenContests; i >= 1; i--) {
      const contestId = i; // Capture in closure
      tokenFetchers.push(() =>
        getContestDetails(provider, tokenContract, contestId)
          .then(contest => {
            if (contest) {
              contest.contractType = 'token';
              return contest;
            }
            return null;
          })
          .catch(() => null)
      );
    }

    // Create fetcher functions for ALL V1 NFT contests (most recent first)
    for (let i = totalNftContests; i >= 1; i--) {
      const contestId = i;
      nftFetchers.push(() =>
        getNftContestDetails(provider, nftContract, contestId)
          .then(contest => {
            if (contest) {
              contest.contractType = 'nft';
              contest.contestIdDisplay = `NFT-${contestId}`;
              return contest;
            }
            return null;
          })
          .catch(() => null)
      );
    }

    // Create fetcher functions for ALL V2 contests (most recent first)
    console.log(`V2 fetch: from ${v2HighestId} down to ${V2_START_CONTEST_ID} (${totalV2Contests} contests)`);
    for (let i = v2HighestId; i >= V2_START_CONTEST_ID; i--) {
      const contestId = i;
      v2Fetchers.push(() =>
        getV2ContestDetails(provider, v2Contract, contestId)
          .then(contest => {
            if (contest) {
              contest.contractType = 'v2';
              contest.contestIdDisplay = `V2-${contestId}`;
              return contest;
            }
            return null;
          })
          .catch((e) => {
            console.error(`V2 contest ${contestId} fetch error:`, e.message);
            return null;
          })
      );
    }

    // Execute fetchers in batches to respect QuickNode 50/sec rate limit
    const batchSize = 10; // Reduced to 10 requests per batch for safety
    const delayMs = 250; // 250ms between batches

    const processBatch = async (fetchers) => {
      const results = [];
      for (let i = 0; i < fetchers.length; i += batchSize) {
        const batch = fetchers.slice(i, i + batchSize);
        // Execute fetchers NOW (they return promises)
        const batchResults = await Promise.all(batch.map(fn => fn()));
        results.push(...batchResults);
        if (i + batchSize < fetchers.length) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      return results;
    };

    console.log(`Fetching ${tokenFetchers.length} token, ${nftFetchers.length} NFT, ${v2Fetchers.length} V2 contests...`);

    // Process each contract type sequentially to avoid rate limits
    const tokenResults = await processBatch(tokenFetchers);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const nftResults = await processBatch(nftFetchers);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const v2Results = await processBatch(v2Fetchers);

    console.log(`Fetched: ${tokenResults.filter(c => c !== null).length} token, ${nftResults.filter(c => c !== null).length} NFT, ${v2Results.filter(c => c !== null).length} V2`);

    // Filter out nulls, combine all contests
    const allContests = [
      ...tokenResults.filter(c => c !== null),
      ...nftResults.filter(c => c !== null),
      ...v2Results.filter(c => c !== null),
    ];

    // Sort by endTime descending (newest first)
    allContests.sort((a, b) => b.endTime - a.endTime);

    // Apply status filter
    let filteredContests = allContests;
    const nowTimestamp = Math.floor(Date.now() / 1000);
    if (statusFilter === 'active') {
      // Only active (status 0) and pending VRF (status 1) contests that haven't ended yet
      filteredContests = allContests.filter(c =>
        (c.status === 0 || c.status === 1) && c.endTime > nowTimestamp
      );
    } else if (statusFilter === 'history') {
      // Only completed (status 2) or cancelled (status 3) contests (default for history tab)
      filteredContests = allContests.filter(c => c.status === 2 || c.status === 3);
    }
    // 'all' returns everything without filtering

    if (hostFilter) {
      filteredContests = filteredContests.filter(c => c.host.toLowerCase() === hostFilter);
    }
    const limitedContests = filteredContests.slice(0, limit);

    // Fetch Farcaster user info for all hosts/winners in PARALLEL
    if (includeUsers && limitedContests.length > 0) {
      // Collect unique addresses to look up
      const addressesToLookup = new Set();
      limitedContests.forEach(contest => {
        addressesToLookup.add(contest.host.toLowerCase());
        // Handle single winner (V1)
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          addressesToLookup.add(contest.winner.toLowerCase());
        }
        // Handle multiple winners (V2)
        if (contest.winners && contest.winners.length > 0) {
          contest.winners.forEach(w => {
            if (w !== '0x0000000000000000000000000000000000000000') {
              addressesToLookup.add(w.toLowerCase());
            }
          });
        }
      });

      // Fetch all users in parallel
      const userPromises = Array.from(addressesToLookup).map(addr =>
        getUserByWallet(addr).then(user => ({ addr, user })).catch(() => ({ addr, user: null }))
      );
      const userResults = await Promise.all(userPromises);

      // Create lookup map
      const userMap = {};
      userResults.forEach(({ addr, user }) => {
        userMap[addr] = user;
      });

      // Assign users to contests
      limitedContests.forEach(contest => {
        contest.hostUser = userMap[contest.host.toLowerCase()] || null;
        // Handle single winner (V1)
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          contest.winnerUser = userMap[contest.winner.toLowerCase()] || null;
        }
        // Handle multiple winners (V2)
        if (contest.winners && contest.winners.length > 0) {
          contest.winnerUsers = contest.winners
            .filter(w => w !== '0x0000000000000000000000000000000000000000')
            .map(w => userMap[w.toLowerCase()] || null);
        }
      });
    }

    // Fetch participant counts from KV storage for all contests
    if (process.env.KV_REST_API_URL && limitedContests.length > 0) {
      try {
        const { kv } = require('@vercel/kv');
        const V2_START_ID = 105;

        const participantPromises = limitedContests.map(async (contest) => {
          const contestId = contest.contestId.toString();
          const isV2Contest = contest.contestId >= V2_START_ID;

          let count = 0;

          if (isV2Contest) {
            // For V2 contests, check both key formats and sum them
            const v2Count = await kv.scard(`contest_entries:v2-${contestId}`).catch(() => 0);
            const legacyCount = await kv.scard(`contest_entries:${contestId}`).catch(() => 0);
            count = (v2Count || 0) + (legacyCount || 0);
          } else {
            count = await kv.scard(`contest_entries:${contestId}`).catch(() => 0);
          }

          return { contestId: contest.contestId, isV2: contest.isV2, count };
        });
        const participantCounts = await Promise.all(participantPromises);

        // Update participant counts in contests
        participantCounts.forEach(({ contestId, isV2, count }) => {
          const contest = limitedContests.find(c => c.contestId === contestId && c.isV2 === isV2);
          if (contest) {
            contest.participantCount = count;
          }
        });
      } catch (kvError) {
        console.error('KV participant count error:', kvError.message);
        // Continue without participant counts if KV fails
      }
    }

    // Fetch social data (likes, recasts, replies) from KV cache for completed contests
    if (process.env.KV_REST_API_URL && limitedContests.length > 0) {
      try {
        const { kv } = require('@vercel/kv');

        const socialPromises = limitedContests.map(async (contest) => {
          // Only fetch social data for completed contests (status 2)
          if (contest.status !== 2) {
            return { contestId: contest.contestId, contractType: contest.contractType, social: null };
          }

          // Determine the cache key based on contract type
          const contestType = contest.contractType; // 'token', 'nft', or 'v2'
          const cacheKey = `contest:social:${contestType}-${contest.contestId}`;

          try {
            const socialData = await kv.get(cacheKey);
            return {
              contestId: contest.contestId,
              contractType: contestType,
              social: socialData || null,
            };
          } catch (e) {
            return { contestId: contest.contestId, contractType: contestType, social: null };
          }
        });

        const socialResults = await Promise.all(socialPromises);

        // Enrich contests with social data
        socialResults.forEach(({ contestId, contractType, social }) => {
          const contest = limitedContests.find(c =>
            c.contestId === contestId && c.contractType === contractType
          );
          if (contest && social) {
            contest.likes = social.likes || 0;
            contest.recasts = social.recasts || 0;
            contest.replies = social.replies || 0;
            contest.socialCapturedAt = social.capturedAt || null;
          }
        });

        console.log(`Enriched ${socialResults.filter(r => r.social).length}/${limitedContests.length} contests with social data`);
      } catch (kvError) {
        console.error('KV social data error:', kvError.message);
        // Continue without social data if KV fails
      }
    }

    return res.status(200).json({
      contests: limitedContests,
      total: totalContests,
      totalToken: totalTokenContests,
      totalNft: totalNftContests,
      totalV2: totalV2Contests,
      fetched: limitedContests.length,
      limit,
      debug: {
        tokenResultsCount: tokenResults.filter(c => c !== null).length,
        nftResultsCount: nftResults.filter(c => c !== null).length,
        v2ResultsCount: v2Results.filter(c => c !== null).length,
        allContestsCount: allContests.length,
        filteredCount: filteredContests.length,
      }
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
