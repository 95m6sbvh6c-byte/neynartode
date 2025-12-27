/**
 * Contest History API
 *
 * Fetches the last N contests from the ContestEscrow contract with full stats.
 * OPTIMIZED: Uses cached getUserByWallet and HTTP cache headers
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
  BASE_RPC: process.env.BASE_RPC_URL || 'https://rpc.ankr.com/base',
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
      metadataUrl = tokenUri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
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
          imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
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
        imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
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

/**
 * Get token info (symbol, decimals, name)
 */
async function getTokenInfo(provider, tokenAddress) {
  // Handle native ETH
  if (tokenAddress === '0x0000000000000000000000000000000000000000') {
    return { symbol: 'ETH', decimals: 18, name: 'Ethereum' };
  }

  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([
      token.symbol().catch(() => 'UNKNOWN'),
      token.decimals().catch(() => 18),
      token.name().catch(() => 'Unknown Token'),
    ]);
    return { symbol, decimals: Number(decimals), name };
  } catch (e) {
    return { symbol: 'UNKNOWN', decimals: 18, name: 'Unknown Token' };
  }
}

/**
 * Fetch full contest details
 */
async function getContestDetails(provider, contract, contestId) {
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

    return {
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
  } catch (e) {
    console.error(`Error fetching contest ${contestId}:`, e.message);
    return null;
  }
}

/**
 * Fetch NFT contest details from NFTContestEscrow
 */
async function getNftContestDetails(provider, contract, contestId) {
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

    // Always use Alchemy API for NFT metadata (more reliable than cached URLs)
    const nftMetadata = await getNftMetadata(provider, nftContract, tokenIdNum, Number(nftType));

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

    return {
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
  } catch (e) {
    console.error(`Error fetching NFT contest ${contestId}:`, e.message);
    return null;
  }
}

/**
 * Fetch V2 ContestManager contest details
 * V2 contests support multiple winners and unified ETH/ERC20/NFT prizes
 */
async function getV2ContestDetails(provider, contract, contestId) {
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

    return {
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

    // Get total contest counts from all contracts
    const [tokenNextId, nftNextId, v2NextId] = await Promise.all([
      tokenContract.nextContestId(),
      nftContract.nextContestId().catch(() => 1), // Default to 1 if no NFT contests yet
      v2Contract.nextContestId().catch(() => 1), // Default to 1 if no V2 contests yet
    ]);
    const totalTokenContests = Number(tokenNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;
    const totalV2Contests = Number(v2NextId) - 1;
    const totalContests = totalTokenContests + totalNftContests + totalV2Contests;

    if (totalContests <= 0) {
      return res.status(200).json({
        contests: [],
        total: 0,
        fetched: 0,
      });
    }

    // Fetch all contests from all contracts in PARALLEL for speed
    const tokenContestPromises = [];
    const nftContestPromises = [];
    const v2ContestPromises = [];

    // Create promises for V1 token contests (most recent first, limited)
    const tokenStartId = Math.max(1, totalTokenContests - limit + 1);
    for (let i = totalTokenContests; i >= tokenStartId; i--) {
      tokenContestPromises.push(
        getContestDetails(provider, tokenContract, i)
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

    // Create promises for V1 NFT contests (most recent first, limited)
    const nftStartId = Math.max(1, totalNftContests - limit + 1);
    for (let i = totalNftContests; i >= nftStartId; i--) {
      nftContestPromises.push(
        getNftContestDetails(provider, nftContract, i)
          .then(contest => {
            if (contest) {
              contest.contractType = 'nft';
              contest.contestIdDisplay = `NFT-${contest.contestId}`;
              return contest;
            }
            return null;
          })
          .catch(() => null)
      );
    }

    // Create promises for V2 contests (most recent first)
    // V2 contests start at ID 105 - limit fetch to avoid timeout
    const V2_START_CONTEST_ID = 105;
    const v2FetchLimit = Math.min(limit * 2, 60); // Fetch at most 60 V2 contests to avoid timeout
    const v2StartId = Math.max(V2_START_CONTEST_ID, totalV2Contests - v2FetchLimit + 1);
    for (let i = totalV2Contests; i >= v2StartId; i--) {
      v2ContestPromises.push(
        getV2ContestDetails(provider, v2Contract, i)
          .then(contest => {
            if (contest) {
              contest.contractType = 'v2';
              contest.contestIdDisplay = `V2-${contest.contestId}`;
              return contest;
            }
            return null;
          })
          .catch(() => null)
      );
    }

    // Execute all contest fetches in parallel
    const [tokenResults, nftResults, v2Results] = await Promise.all([
      Promise.all(tokenContestPromises),
      Promise.all(nftContestPromises),
      Promise.all(v2ContestPromises),
    ]);

    // Filter out nulls and combine all contests
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

    return res.status(200).json({
      contests: limitedContests,
      total: totalContests,
      totalToken: totalTokenContests,
      totalNft: totalNftContests,
      totalV2: totalV2Contests,
      fetched: limitedContests.length,
      limit,
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
