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

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address nftContract, uint256 tokenId, uint256 amount, uint8 nftType, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
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
 * Get NFT metadata (name, image) from contract
 */
async function getNftMetadata(provider, nftContract, tokenId, nftType) {
  try {
    let tokenUri = null;
    let collectionName = 'NFT';

    if (nftType === 0) { // ERC721
      const nft = new ethers.Contract(nftContract, ERC721_ABI, provider);
      tokenUri = await nft.tokenURI(tokenId).catch(() => null);
      collectionName = await nft.name().catch(() => 'NFT Collection');
    } else { // ERC1155
      const nft = new ethers.Contract(nftContract, ERC1155_ABI, provider);
      tokenUri = await nft.uri(tokenId).catch(() => null);
      // Replace {id} placeholder in ERC1155 URIs
      if (tokenUri) {
        tokenUri = tokenUri.replace('{id}', tokenId.toString().padStart(64, '0'));
      }
    }

    if (!tokenUri) {
      return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
    }

    // Convert IPFS URLs
    if (tokenUri.startsWith('ipfs://')) {
      tokenUri = tokenUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    // Fetch metadata
    const response = await fetch(tokenUri, { timeout: 5000 });
    if (!response.ok) {
      return { name: `${collectionName} #${tokenId}`, image: '', collection: collectionName };
    }

    const metadata = await response.json();
    let imageUrl = metadata.image || metadata.image_url || '';
    if (imageUrl.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    return {
      name: metadata.name || `${collectionName} #${tokenId}`,
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

    const [host, nftContract, tokenId, amount, nftType, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contestData;

    // Extract actual cast hash, parse requirements, and cached image URL FIRST
    // Format: castHash|R1L0P1|imageUrl (image URL is optional)
    const castParts = castId.split('|');
    const actualCastHash = castParts[0];
    const cachedImageUrl = castParts[2] || ''; // Third part is cached image URL

    // Only fetch NFT metadata if we don't have a cached image (saves IPFS calls)
    let nftMetadata;
    if (cachedImageUrl) {
      // Use cached image, just get collection name
      nftMetadata = { name: `NFT #${tokenId}`, image: cachedImageUrl, collection: 'NFT' };
      // Try to get collection name quickly (optional)
      try {
        const nft = new ethers.Contract(nftContract, ERC721_ABI, provider);
        nftMetadata.collection = await nft.name().catch(() => 'NFT Collection');
        nftMetadata.name = `${nftMetadata.collection} #${tokenId}`;
      } catch (e) { /* ignore */ }
    } else {
      // No cached image, do full metadata fetch
      nftMetadata = await getNftMetadata(provider, nftContract, Number(tokenId), Number(nftType));
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
    const allContests = [];

    // Fetch token contests
    for (let i = totalTokenContests; i >= 1; i--) {
      const contest = await getContestDetails(provider, tokenContract, i);
      if (contest) {
        contest.contractType = 'token';
        allContests.push(contest);
      }
    }

    // Fetch NFT contests
    for (let i = totalNftContests; i >= 1; i--) {
      const contest = await getNftContestDetails(provider, nftContract, i);
      if (contest) {
        contest.contractType = 'nft';
        // Use different ID namespace to avoid collisions (prefix with 'nft-')
        contest.contestIdDisplay = `NFT-${contest.contestId}`;
        allContests.push(contest);
      }
    }

    // Sort by endTime descending (newest first)
    allContests.sort((a, b) => b.endTime - a.endTime);

    // Apply filters and limit
    const contests = [];
    let fetched = 0;

    for (const contest of allContests) {
      if (contests.length >= limit) break;
      fetched++;

      // Apply host filter if specified
      if (hostFilter && contest.host.toLowerCase() !== hostFilter) {
        continue;
      }

      // Fetch Farcaster user info for host and winner if requested
      if (includeUsers) {
        const [hostUser, winnerUser] = await Promise.all([
          getUserByWallet(contest.host),
          contest.winner !== '0x0000000000000000000000000000000000000000'
            ? getUserByWallet(contest.winner)
            : Promise.resolve(null),
        ]);

        contest.hostUser = hostUser;
        contest.winnerUser = winnerUser;
      }

      contests.push(contest);
    }

    return res.status(200).json({
      contests,
      total: totalContests,
      totalToken: totalTokenContests,
      totalNft: totalNftContests,
      fetched: fetched,
      limit,
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
