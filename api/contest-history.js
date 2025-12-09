/**
 * Contest History API
 *
 * Fetches the last N contests from the ContestEscrow contract with full stats.
 *
 * Usage:
 *   GET /api/contest-history?limit=20
 *   GET /api/contest-history?host=0x123...  (filter by host)
 *
 * Returns: Array of contest objects with full stats
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922', // V3 deployed 2025-12-05 (supports restricted NFTs)
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
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

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

const ERC721_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)',
];

const ERC1155_ABI = [
  'function uri(uint256 tokenId) view returns (string)',
];

// Alchemy API for NFT metadata (avoids CORS issues)
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'QooWtq9nKQlkeqKF_-rvC';
const ALCHEMY_NFT_URL = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

// Status mapping
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

/**
 * Get NFT metadata (name, image) using Alchemy API
 * This avoids CORS issues with direct metadata fetches (e.g., Basenames)
 */
async function getNftMetadata(provider, nftContract, tokenId, nftType) {
  try {
    // Use Alchemy's getNFTMetadata API - handles all NFT types and caches images
    const url = `${ALCHEMY_NFT_URL}/getNFTMetadata?contractAddress=${nftContract}&tokenId=${tokenId}&refreshCache=false`;

    const response = await fetch(url);
    if (!response.ok) {
      console.error('Alchemy NFT API error:', response.status);
      return { name: `NFT #${tokenId}`, image: '', collection: 'NFT' };
    }

    const nft = await response.json();

    // Get collection name
    const collectionName = nft.contract?.name ||
                          nft.contract?.openSeaMetadata?.collectionName ||
                          'NFT Collection';

    // Get the best image URL (Alchemy provides cached versions)
    let imageUrl = nft.image?.cachedUrl ||
                   nft.image?.pngUrl ||
                   nft.image?.thumbnailUrl ||
                   nft.image?.originalUrl ||
                   nft.raw?.metadata?.image ||
                   '';

    // Handle IPFS URLs (shouldn't happen with Alchemy cached URLs but just in case)
    if (imageUrl.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    return {
      name: nft.name || nft.raw?.metadata?.name || `${collectionName} #${tokenId}`,
      image: imageUrl,
      collection: collectionName,
    };
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

    // Extract actual cast hash, parse requirements, and cached image URL FIRST
    // Format: castHash|R1L0P1|imageUrl (image URL is optional)
    const castParts = castId.split('|');
    const actualCastHash = castParts[0];
    const cachedImageUrl = castParts[2] || ''; // Third part is cached image URL

    // Convert tokenId to number for display
    const tokenIdNum = Number(tokenId);

    // Only fetch NFT metadata if we don't have a cached image (saves IPFS calls)
    let nftMetadata;
    if (cachedImageUrl) {
      // Use cached image, get collection name from contract
      let collectionName = 'NFT Collection';
      try {
        const nft = new ethers.Contract(nftContract, ERC721_ABI, provider);
        collectionName = await nft.name().catch(() => 'NFT Collection');
      } catch (e) { /* ignore */ }
      nftMetadata = {
        name: `${collectionName} #${tokenIdNum}`,
        image: cachedImageUrl,
        collection: collectionName
      };
    } else {
      // No cached image, do full metadata fetch
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

    // Use cached image URL if available, otherwise fetch from contract
    const finalNftImage = cachedImageUrl || nftMetadata.image;

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
    const tokenContract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const nftContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);

    // Parse query params
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Max 50
    const hostFilter = req.query.host?.toLowerCase();
    const includeUsers = req.query.includeUsers !== 'false'; // Default true
    // Status filter: 'active' = only active/pending, 'history' = only completed/cancelled (default), 'all' = everything
    const statusFilter = req.query.status || 'history';

    // Get total contest counts from both contracts
    const [tokenNextId, nftNextId] = await Promise.all([
      tokenContract.nextContestId(),
      nftContract.nextContestId().catch(() => 1), // Default to 1 if no NFT contests yet
    ]);
    const totalTokenContests = Number(tokenNextId) - 1;
    const totalNftContests = Number(nftNextId) - 1;
    const totalContests = totalTokenContests + totalNftContests;

    if (totalContests <= 0) {
      return res.status(200).json({
        contests: [],
        total: 0,
        fetched: 0,
      });
    }

    // Fetch all contests from both contracts
    // Fetch all contests in PARALLEL for speed
    const tokenContestPromises = [];
    const nftContestPromises = [];

    // Create promises for token contests (most recent first, limited)
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

    // Create promises for NFT contests (most recent first, limited)
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

    // Execute all contest fetches in parallel
    const [tokenResults, nftResults] = await Promise.all([
      Promise.all(tokenContestPromises),
      Promise.all(nftContestPromises),
    ]);

    // Filter out nulls and combine
    const allContests = [
      ...tokenResults.filter(c => c !== null),
      ...nftResults.filter(c => c !== null),
    ];

    // Sort by endTime descending (newest first)
    allContests.sort((a, b) => b.endTime - a.endTime);

    // Apply status filter
    let filteredContests = allContests;
    if (statusFilter === 'active') {
      // Only active (status 0) and pending VRF (status 1) contests
      filteredContests = allContests.filter(c => c.status === 0 || c.status === 1);
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
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          addressesToLookup.add(contest.winner.toLowerCase());
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
        if (contest.winner !== '0x0000000000000000000000000000000000000000') {
          contest.winnerUser = userMap[contest.winner.toLowerCase()] || null;
        }
      });
    }

    return res.status(200).json({
      contests: limitedContests,
      total: totalContests,
      totalToken: totalTokenContests,
      totalNft: totalNftContests,
      fetched: limitedContests.length,
      limit,
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
