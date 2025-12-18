/**
 * Winner Announcement API
 *
 * This endpoint checks for completed contests and posts winner announcements
 * as replies to the original cast.
 *
 * Supports both ETH prize contests and NFT prize contests.
 *
 * Flow:
 * 1. Check for contests in "Completed" status that haven't been announced
 * 2. Get winner address from contract
 * 3. Look up winner's Farcaster username via their wallet
 * 4. Post reply to original cast with winner announcement
 *
 * Usage:
 *   POST /api/announce-winner (cron - checks all completed ETH + NFT contests)
 *   GET /api/announce-winner?contestId=7 (announce specific ETH contest)
 *   GET /api/announce-winner?contestId=2&nft=true (announce specific NFT contest)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  // V1 contracts (legacy)
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',

  // V2 contract (multi-winner support)
  CONTEST_MANAGER: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06',
  V2_START_CONTEST_ID: 105,

  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

// V2 ContestManager ABI (multi-winner support)
const CONTEST_MANAGER_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function getWinners(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const ERC721_ABI = [
  'function name() view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
];

const ERC1155_ABI = [
  'function uri(uint256 id) view returns (string)',
];

// Alchemy API for NFT metadata (avoids CORS issues)
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'QooWtq9nKQlkeqKF_-rvC';
const ALCHEMY_NFT_URL = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

/**
 * Fetch NFT image URL using Alchemy API
 * This avoids CORS issues with direct metadata fetches (e.g., Basenames)
 */
async function fetchNftImage(nftContract, tokenId) {
  try {
    if (!nftContract || tokenId === undefined) return null;

    const url = `${ALCHEMY_NFT_URL}/getNFTMetadata?contractAddress=${nftContract}&tokenId=${tokenId}&refreshCache=false`;
    console.log(`   Fetching NFT image from Alchemy: ${nftContract} #${tokenId}`);

    const response = await fetch(url);
    if (!response.ok) {
      console.log(`   Alchemy API error: ${response.status}`);
      return null;
    }

    const nft = await response.json();

    // Get the best image URL (Alchemy provides cached versions)
    let imageUrl = nft.image?.cachedUrl ||
                   nft.image?.pngUrl ||
                   nft.image?.thumbnailUrl ||
                   nft.image?.originalUrl ||
                   nft.raw?.metadata?.image ||
                   null;

    // Handle IPFS URLs
    if (imageUrl?.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    console.log(`   NFT image URL: ${imageUrl || 'not found'}`);
    return imageUrl;
  } catch (e) {
    console.log(`   Error fetching NFT metadata from Alchemy: ${e.message}`);
    return null;
  }
}

// Track announced contests using KV for persistence across serverless cold starts
async function isAlreadyAnnounced(contestId, isNftContest = false) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const prefix = isNftContest ? 'announced_nft_' : 'announced_';
      const announced = await kv.get(`${prefix}${contestId}`);
      return !!announced;
    }
  } catch (e) {
    console.log('   Could not check announced status:', e.message);
  }
  return false;
}

async function markAsAnnounced(contestId, isNftContest = false) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const prefix = isNftContest ? 'announced_nft_' : 'announced_';
      await kv.set(`${prefix}${contestId}`, true);
    }
  } catch (e) {
    console.log('   Could not mark as announced:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Get Farcaster user by wallet address
 * Uses the bulk-by-address endpoint which returns users mapped by address
 */
async function getUserByWallet(walletAddress) {
  try {
    const normalizedAddress = walletAddress.toLowerCase();
    console.log(`   Looking up Farcaster user for wallet: ${normalizedAddress}`);

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${normalizedAddress}`,
      {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`   Neynar API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    console.log(`   Neynar response keys: ${Object.keys(data).join(', ')}`);

    // Response format: { "0xaddress": [array of users] }
    const users = data[normalizedAddress];

    if (users && users.length > 0) {
      const user = users[0];
      console.log(`   ✅ Found Farcaster user: @${user.username} (FID: ${user.fid})`);
      return user;
    }

    console.log(`   No Farcaster user found for ${normalizedAddress}`);
    return null;
  } catch (error) {
    console.error('Error fetching user by wallet:', error);
    return null;
  }
}

/**
 * Post a winner announcement as a new cast that quotes the original contest cast
 * @param {string} quotedCastHash - The original contest cast hash to quote
 * @param {string} message - The announcement message
 * @param {string} signerUuid - Neynar signer UUID
 * @param {string} nftImageUrl - Optional NFT image URL to embed
 */
async function postWinnerAnnouncement(quotedCastHash, message, signerUuid, nftImageUrl = null) {
  try {
    // Need a signer UUID to post casts - this should be set up in Neynar dashboard
    if (!signerUuid) {
      console.log('   ⚠️ No NEYNAR_SIGNER_UUID configured - cannot post cast');
      return { success: false, error: 'No signer configured' };
    }

    // Build the Warpcast URL for the quoted cast
    const quotedCastUrl = `https://warpcast.com/~/conversations/${quotedCastHash}`;

    // Build embeds array - quote cast first, then NFT image if available
    const embeds = [{ url: quotedCastUrl }];
    if (nftImageUrl) {
      embeds.push({ url: nftImageUrl });
      console.log(`   Embedding NFT image: ${nftImageUrl}`);
    }

    // Post as a new cast (not a reply) with the original cast embedded as a quote
    const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': CONFIG.NEYNAR_API_KEY
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        text: message,
        embeds: embeds
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   Failed to post cast:', errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    console.log('   ✅ Winner announcement posted!');
    return { success: true, castHash: data.cast?.hash };
  } catch (error) {
    console.error('Error posting cast:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get stored custom message for a contest
 * Reads directly from Vercel KV for reliability
 */
async function getCustomMessage(contestId) {
  try {
    // Use Vercel KV directly (more reliable than HTTP call)
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const message = await kv.get(`contest_message_${contestId}`);
      if (message) {
        console.log(`   ✅ Found custom message in KV for contest ${contestId}`);
        return message;
      }
    }
  } catch (e) {
    console.log('   Could not fetch custom message from KV:', e.message);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ANNOUNCEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Announce winner for a specific contest
 */
async function announceWinner(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  // Get contest details
  const contest = await contestEscrow.getContest(contestId);
  const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 2n) {
    return {
      success: false,
      error: `Contest not completed (status: ${status})`,
      contestId
    };
  }

  if (winner === '0x0000000000000000000000000000000000000000') {
    return {
      success: false,
      error: 'No winner set',
      contestId
    };
  }

  // Check if already announced (using KV for persistence)
  if (await isAlreadyAnnounced(contestId)) {
    return {
      success: false,
      error: 'Already announced',
      contestId
    };
  }

  console.log(`\n🎉 Announcing winner for Contest #${contestId}`);
  console.log(`   Host: ${host}`);
  console.log(`   Winner: ${winner}`);

  // Get host's Farcaster profile
  const hostUser = await getUserByWallet(host);
  const hostTag = hostUser ? `@${hostUser.username}` : null;
  console.log(`   Host tag: ${hostTag || 'not found'}`);

  // Get winner's Farcaster profile
  const winnerUser = await getUserByWallet(winner);
  const winnerTag = winnerUser ? `@${winnerUser.username}` : winner.slice(0, 10) + '...';
  // Use username for congrats message (display names can have weird unicode)
  const winnerDisplay = winnerUser ? winnerUser.username : 'Winner';

  // Get prize info
  let prizeDisplay = '';
  if (prizeToken === '0x0000000000000000000000000000000000000000') {
    prizeDisplay = `${ethers.formatEther(prizeAmount)} ETH`;
  } else {
    try {
      const tokenContract = new ethers.Contract(prizeToken, ERC20_ABI, provider);
      const symbol = await tokenContract.symbol();
      const decimals = await tokenContract.decimals();
      const amount = Number(prizeAmount) / Math.pow(10, Number(decimals));
      prizeDisplay = `${amount.toLocaleString()} $${symbol}`;
    } catch (e) {
      prizeDisplay = `${ethers.formatEther(prizeAmount)} tokens`;
    }
  }

  // Get qualified entries count
  const qualifiedEntries = await contestEscrow.getQualifiedEntries(contestId);
  const participantCount = qualifiedEntries.length;

  // Get custom message (if stored)
  const customMessage = await getCustomMessage(contestId);

  // Get finalize TX hash (if stored)
  let finalizeTxHash = null;
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      finalizeTxHash = await kv.get(`finalize_tx_${contestId}`);
      if (finalizeTxHash) {
        console.log(`   Found finalize TX: ${finalizeTxHash}`);
      }
    }
  } catch (e) {
    console.log(`   Could not get finalize TX:`, e.message);
  }

  // Build announcement message
  let announcement = `🎉 CONTEST COMPLETE!\n\n`;

  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }

  // Add host tag if found
  if (hostTag) {
    announcement += `🎤 Host: ${hostTag}\n`;
  }

  announcement += `🏆 Winner: ${winnerTag}\n`;
  announcement += `💰 Prize: ${prizeDisplay}\n`;
  announcement += `👥 Participants: ${participantCount}\n`;
  announcement += `🎲 Selected via Chainlink VRF\n`;

  // Add TX hash link if available
  if (finalizeTxHash) {
    announcement += `🔗 TX: basescan.org/tx/${finalizeTxHash.slice(0, 10)}...\n`;
  }

  announcement += `\nCongrats ${winnerTag}! 🦎\n\n`;
  announcement += `Launch your own contest: https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes`;

  console.log(`   Message: ${announcement.slice(0, 100)}...`);

  // Extract actual cast hash (remove requirements suffix if present)
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

  // Post the announcement
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!signerUuid) {
    console.log('   ⚠️ NEYNAR_SIGNER_UUID not set - skipping cast post');
    console.log('   Would have posted:', announcement);

    // Mark as announced anyway (for dry run)
    await markAsAnnounced(contestId);

    return {
      success: true,
      contestId,
      winner,
      winnerUsername: winnerUser?.username,
      prize: prizeDisplay,
      participants: participantCount,
      message: announcement,
      posted: false,
      note: 'Set NEYNAR_SIGNER_UUID to enable automatic cast posting'
    };
  }

  const postResult = await postWinnerAnnouncement(actualCastHash, announcement, signerUuid);

  if (postResult.success) {
    await markAsAnnounced(contestId);

    // Send push notification to all subscribers
    try {
      const { sendNotification } = require('./send-notification');
      await sendNotification('contest_completed', {
        contestId,
        winnerUsername: winnerUser?.username,
        prize: prizeDisplay,
      });
    } catch (e) {
      console.log('   Could not send push notification:', e.message);
    }
  }

  return {
    success: postResult.success,
    contestId,
    winner,
    winnerUsername: winnerUser?.username,
    prize: prizeDisplay,
    participants: participantCount,
    message: announcement,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

/**
 * Announce winner for a specific NFT contest
 */
async function announceNftWinner(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const nftEscrow = new ethers.Contract(
    CONFIG.NFT_CONTEST_ESCROW,
    NFT_CONTEST_ESCROW_ABI,
    provider
  );

  // Get contest details
  // NFT: host, nftType, nftContract, tokenId, amount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner
  const contest = await nftEscrow.getContest(contestId);
  const [host, nftType, nftContract, tokenId, amount, , , castId, , , status, winner] = contest;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 2n) {
    return {
      success: false,
      error: `NFT Contest not completed (status: ${status})`,
      contestId,
      isNft: true
    };
  }

  if (winner === '0x0000000000000000000000000000000000000000') {
    return {
      success: false,
      error: 'No winner set',
      contestId,
      isNft: true
    };
  }

  // Check if already announced (using KV for persistence)
  if (await isAlreadyAnnounced(contestId, true)) {
    return {
      success: false,
      error: 'Already announced',
      contestId,
      isNft: true
    };
  }

  console.log(`\n🎉 Announcing winner for NFT Contest #${contestId}`);
  console.log(`   Host: ${host}`);
  console.log(`   Winner: ${winner}`);
  console.log(`   NFT Contract: ${nftContract}`);
  console.log(`   Token ID: ${tokenId}`);

  // Get host's Farcaster profile
  const hostUser = await getUserByWallet(host);
  const hostTag = hostUser ? `@${hostUser.username}` : null;
  console.log(`   Host tag: ${hostTag || 'not found'}`);

  // Get winner's Farcaster profile
  const winnerUser = await getUserByWallet(winner);
  const winnerTag = winnerUser ? `@${winnerUser.username}` : winner.slice(0, 10) + '...';

  // Get NFT info for prize display and image using Alchemy
  let prizeDisplay = '';
  let nftImageUrl = null;
  const nftTypeName = nftType === 0n ? 'ERC721' : 'ERC1155';

  try {
    // Get collection name from contract
    const nftContractInstance = new ethers.Contract(nftContract, ERC721_ABI, provider);
    const name = await nftContractInstance.name().catch(() => 'NFT');

    if (nftType === 0n) {
      // ERC721
      prizeDisplay = `${name} #${tokenId}`;
    } else {
      // ERC1155
      prizeDisplay = `${Number(amount)}x ${name} #${tokenId}`;
    }

    // Use Alchemy API to get NFT image (handles all NFT types, avoids CORS)
    nftImageUrl = await fetchNftImage(nftContract, tokenId.toString());
  } catch (e) {
    prizeDisplay = `${nftTypeName} #${tokenId}`;
    // Still try to get image via Alchemy even if name lookup failed
    nftImageUrl = await fetchNftImage(nftContract, tokenId.toString());
  }

  console.log(`   NFT Image URL: ${nftImageUrl || 'not found'}`)

  // Get qualified entries count
  const qualifiedEntries = await nftEscrow.getQualifiedEntries(contestId);
  const participantCount = qualifiedEntries.length;

  // Get custom message (if stored) - use nft prefix
  const customMessage = await getCustomMessage(`nft_${contestId}`);

  // Get finalize TX hash (if stored) - use nft prefix
  let finalizeTxHash = null;
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      finalizeTxHash = await kv.get(`finalize_tx_nft_${contestId}`);
      if (finalizeTxHash) {
        console.log(`   Found finalize TX: ${finalizeTxHash}`);
      }
    }
  } catch (e) {
    console.log(`   Could not get finalize TX:`, e.message);
  }

  // Build announcement message
  let announcement = `🎉 NFT CONTEST COMPLETE!\n\n`;

  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }

  // Add host tag if found
  if (hostTag) {
    announcement += `🎤 Host: ${hostTag}\n`;
  }

  announcement += `🏆 Winner: ${winnerTag}\n`;
  announcement += `🖼️ Prize: ${prizeDisplay}\n`;
  announcement += `👥 Participants: ${participantCount}\n`;
  announcement += `🎲 Selected via Chainlink VRF\n`;

  // Add TX hash link if available
  if (finalizeTxHash) {
    announcement += `🔗 TX: basescan.org/tx/${finalizeTxHash.slice(0, 10)}...\n`;
  }

  announcement += `\nCongrats ${winnerTag}! 🦎\n\n`;
  announcement += `Launch your own contest: https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes`;

  console.log(`   Message: ${announcement.slice(0, 100)}...`);

  // Extract actual cast hash (remove requirements suffix if present)
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

  // Post the announcement
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!signerUuid) {
    console.log('   ⚠️ NEYNAR_SIGNER_UUID not set - skipping cast post');
    console.log('   Would have posted:', announcement);

    // Mark as announced anyway (for dry run)
    await markAsAnnounced(contestId, true);

    return {
      success: true,
      contestId,
      isNft: true,
      winner,
      winnerUsername: winnerUser?.username,
      prize: prizeDisplay,
      participants: participantCount,
      message: announcement,
      posted: false,
      note: 'Set NEYNAR_SIGNER_UUID to enable automatic cast posting'
    };
  }

  const postResult = await postWinnerAnnouncement(actualCastHash, announcement, signerUuid, nftImageUrl);

  if (postResult.success) {
    await markAsAnnounced(contestId, true);

    // Send push notification to all subscribers
    try {
      const { sendNotification } = require('./send-notification');
      await sendNotification('contest_completed', {
        contestId,
        isNft: true,
        winnerUsername: winnerUser?.username,
        prize: prizeDisplay,
      });
    } catch (e) {
      console.log('   Could not send push notification:', e.message);
    }
  }

  return {
    success: postResult.success,
    contestId,
    isNft: true,
    winner,
    winnerUsername: winnerUser?.username,
    prize: prizeDisplay,
    nftImageUrl: nftImageUrl,
    participants: participantCount,
    message: announcement,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

/**
 * Announce winners for a V2 ContestManager contest (multi-winner support)
 * Tags all winners in the announcement cast
 */
async function announceV2Winners(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(
    CONFIG.CONTEST_MANAGER,
    CONTEST_MANAGER_ABI,
    provider
  );

  // Get contest details
  // V2: host, contestType, status, castId, endTime, prizeToken, prizeAmount, winnerCount, winners
  const contest = await contestManager.getContest(contestId);
  const [host, contestType, status, castId, , prizeToken, prizeAmount, winnerCount, winners] = contest;

  // ContestType: 0=ETH, 1=ERC20, 2=BaseNFT, 3=MainnetNFT
  const contestTypeNames = ['ETH', 'ERC20', 'BaseNFT', 'MainnetNFT'];
  const typeName = contestTypeNames[Number(contestType)] || 'Unknown';
  const isNftContest = contestType === 2n || contestType === 3n;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 2n) {
    return {
      success: false,
      error: `V2 Contest not completed (status: ${status})`,
      contestId,
      isV2: true
    };
  }

  if (!winners || winners.length === 0) {
    return {
      success: false,
      error: 'No winners set',
      contestId,
      isV2: true
    };
  }

  // Check if already announced (using KV for persistence)
  if (await isAlreadyAnnounced(contestId, false)) {
    // Check v2 prefix too
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        const announced = await kv.get(`announced_v2_${contestId}`);
        if (announced) {
          return {
            success: false,
            error: 'Already announced',
            contestId,
            isV2: true
          };
        }
      }
    } catch (e) { /* continue */ }
  }

  console.log(`\n🎉 Announcing ${winners.length} winner(s) for V2 ${typeName} Contest #${contestId}`);
  console.log(`   Host: ${host}`);
  console.log(`   Winners: ${winners.join(', ')}`);

  // Get host's Farcaster profile
  const hostUser = await getUserByWallet(host);
  const hostTag = hostUser ? `@${hostUser.username}` : null;
  console.log(`   Host tag: ${hostTag || 'not found'}`);

  // Deduplicate winners (same address may win multiple times due to bonus entries)
  const uniqueWinners = [...new Set(winners.map(w => w.toLowerCase()))];
  console.log(`   Unique winners: ${uniqueWinners.length} (from ${winners.length} total picks)`);

  // Get all winners' Farcaster profiles
  const winnerProfiles = [];
  for (const winnerAddr of uniqueWinners) {
    const winnerUser = await getUserByWallet(winnerAddr);
    winnerProfiles.push({
      address: winnerAddr,
      user: winnerUser,
      tag: winnerUser ? `@${winnerUser.username}` : winnerAddr.slice(0, 10) + '...'
    });
    console.log(`   Winner: ${winnerUser ? `@${winnerUser.username}` : winnerAddr}`);
  }

  // Get prize info (use unique winner count for per-winner calculation)
  let prizeDisplay = '';
  let perWinnerPrize = '';
  const uniqueWinnerCount = uniqueWinners.length;

  if (contestType === 0n) {
    // ETH prize
    const totalEth = Number(ethers.formatEther(prizeAmount));
    const perWinner = totalEth / uniqueWinnerCount;
    prizeDisplay = `${totalEth.toFixed(4)} ETH`;
    perWinnerPrize = uniqueWinnerCount > 1 ? ` (${perWinner.toFixed(4)} ETH each)` : '';
  } else if (contestType === 1n) {
    // ERC20 prize
    try {
      const tokenContract = new ethers.Contract(prizeToken, ERC20_ABI, provider);
      const symbol = await tokenContract.symbol();
      const decimals = await tokenContract.decimals();
      const totalAmount = Number(prizeAmount) / Math.pow(10, Number(decimals));
      const perWinner = totalAmount / uniqueWinnerCount;
      prizeDisplay = `${totalAmount.toLocaleString()} $${symbol}`;
      perWinnerPrize = uniqueWinnerCount > 1 ? ` (${perWinner.toLocaleString()} each)` : '';
    } catch (e) {
      prizeDisplay = `${ethers.formatEther(prizeAmount)} tokens`;
    }
  } else {
    // NFT prize (single winner only for NFTs)
    prizeDisplay = `NFT #${prizeAmount}`;
  }

  // Get qualified entries count
  const qualifiedEntries = await contestManager.getQualifiedEntries(contestId);
  const participantCount = qualifiedEntries.length;

  // Get custom message (if stored)
  const customMessage = await getCustomMessage(`v2_${contestId}`);

  // Get finalize TX hash (if stored)
  let finalizeTxHash = null;
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      finalizeTxHash = await kv.get(`finalize_tx_v2_${contestId}`);
      if (finalizeTxHash) {
        console.log(`   Found finalize TX: ${finalizeTxHash}`);
      }
    }
  } catch (e) {
    console.log(`   Could not get finalize TX:`, e.message);
  }

  // Build announcement message
  let announcement = isNftContest
    ? `🎉 NFT CONTEST COMPLETE!\n\n`
    : `🎉 CONTEST COMPLETE!\n\n`;

  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }

  // Add host tag if found
  if (hostTag) {
    announcement += `🎤 Host: ${hostTag}\n`;
  }

  // List all winners with tags
  if (winners.length === 1) {
    announcement += `🏆 Winner: ${winnerProfiles[0].tag}\n`;
  } else {
    announcement += `🏆 Winners:\n`;
    winnerProfiles.forEach((wp, i) => {
      announcement += `   ${i + 1}. ${wp.tag}\n`;
    });
  }

  announcement += `💰 Prize: ${prizeDisplay}${perWinnerPrize}\n`;
  announcement += `👥 Participants: ${participantCount}\n`;
  announcement += `🎲 Selected via Chainlink VRF\n`;

  // Add TX hash link if available
  if (finalizeTxHash) {
    announcement += `🔗 TX: basescan.org/tx/${finalizeTxHash.slice(0, 10)}...\n`;
  }

  // Congratulate all winners by tagging them
  const allWinnerTags = winnerProfiles.map(wp => wp.tag).join(' ');
  announcement += `\nCongrats ${allWinnerTags}! 🦎\n\n`;
  announcement += `Launch your own contest: https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes`;

  console.log(`   Message length: ${announcement.length} chars`);

  // Extract actual cast hash (remove requirements suffix if present)
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;

  // Post the announcement
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!signerUuid) {
    console.log('   ⚠️ NEYNAR_SIGNER_UUID not set - skipping cast post');
    console.log('   Would have posted:', announcement);

    // Mark as announced anyway (for dry run)
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        await kv.set(`announced_v2_${contestId}`, true);
      }
    } catch (e) { /* ignore */ }

    return {
      success: true,
      contestId,
      isV2: true,
      winners: winners,
      winnerUsernames: winnerProfiles.map(wp => wp.user?.username).filter(Boolean),
      prize: prizeDisplay,
      participants: participantCount,
      message: announcement,
      posted: false,
      note: 'Set NEYNAR_SIGNER_UUID to enable automatic cast posting'
    };
  }

  const postResult = await postWinnerAnnouncement(actualCastHash, announcement, signerUuid);

  if (postResult.success) {
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        await kv.set(`announced_v2_${contestId}`, true);
      }
    } catch (e) { /* ignore */ }

    // Send push notification
    try {
      const { sendNotification } = require('./send-notification');
      await sendNotification('contest_completed', {
        contestId,
        isV2: true,
        winnerCount: winners.length,
        winnerUsernames: winnerProfiles.map(wp => wp.user?.username).filter(Boolean),
        prize: prizeDisplay,
      });
    } catch (e) {
      console.log('   Could not send push notification:', e.message);
    }
  }

  return {
    success: postResult.success,
    contestId,
    isV2: true,
    winners: winners,
    winnerUsernames: winnerProfiles.map(wp => wp.user?.username).filter(Boolean),
    prize: prizeDisplay,
    participants: participantCount,
    message: announcement,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

/**
 * Check all contests (ETH + NFT + V2) and announce any completed ones
 */
async function checkAndAnnounceAll() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const results = [];

  // Check ETH contests
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const ethNextId = await contestEscrow.nextContestId();
  console.log(`\n🔍 Checking ETH contests 1 to ${ethNextId - 1n} for announcements...`);

  for (let i = 1n; i < ethNextId; i++) {
    try {
      const contest = await contestEscrow.getContest(i);
      const status = contest[8];
      const winner = contest[9];

      // Only announce completed contests with winners
      if (status === 2n && winner !== '0x0000000000000000000000000000000000000000') {
        if (!(await isAlreadyAnnounced(Number(i), false))) {
          const result = await announceWinner(Number(i));
          results.push(result);
        }
      }
    } catch (e) {
      console.log(`   ETH Contest #${i} error:`, e.message?.slice(0, 50));
    }
  }

  // Check NFT contests
  const nftEscrow = new ethers.Contract(
    CONFIG.NFT_CONTEST_ESCROW,
    NFT_CONTEST_ESCROW_ABI,
    provider
  );

  const nftNextId = await nftEscrow.nextContestId();
  console.log(`\n🔍 Checking NFT contests 1 to ${nftNextId - 1n} for announcements...`);

  for (let i = 1n; i < nftNextId; i++) {
    try {
      const contest = await nftEscrow.getContest(i);
      const status = contest[10]; // status is at index 10 for NFT contests
      const winner = contest[11]; // winner is at index 11 for NFT contests

      // Only announce completed contests with winners
      if (status === 2n && winner !== '0x0000000000000000000000000000000000000000') {
        if (!(await isAlreadyAnnounced(Number(i), true))) {
          const result = await announceNftWinner(Number(i));
          results.push(result);
        }
      }
    } catch (e) {
      console.log(`   NFT Contest #${i} error:`, e.message?.slice(0, 50));
    }
  }

  // Check V2 ContestManager contests
  const contestManager = new ethers.Contract(
    CONFIG.CONTEST_MANAGER,
    CONTEST_MANAGER_ABI,
    provider
  );

  try {
    const v2NextId = await contestManager.nextContestId();
    const v2StartId = BigInt(CONFIG.V2_START_CONTEST_ID);

    if (v2NextId > v2StartId) {
      console.log(`\n🔍 Checking V2 contests ${v2StartId} to ${v2NextId - 1n} for announcements...`);

      for (let i = v2StartId; i < v2NextId; i++) {
        try {
          const contest = await contestManager.getContest(i);
          const status = contest[2]; // status is at index 2 for V2
          const winners = contest[8]; // winners array is at index 8

          // Only announce completed contests with winners
          if (status === 2n && winners && winners.length > 0) {
            // Check if already announced
            let alreadyAnnounced = false;
            try {
              if (process.env.KV_REST_API_URL) {
                const { kv } = require('@vercel/kv');
                alreadyAnnounced = await kv.get(`announced_v2_${i}`);
              }
            } catch (e) { /* continue */ }

            if (!alreadyAnnounced) {
              const result = await announceV2Winners(Number(i));
              results.push(result);
            }
          }
        } catch (e) {
          console.log(`   V2 Contest #${i} error:`, e.message?.slice(0, 50));
        }
      }
    } else {
      console.log(`\n🔍 No V2 contests yet (next ID: ${v2NextId})`);
    }
  } catch (e) {
    console.log(`\n⚠️ Could not check V2 contests:`, e.message?.slice(0, 50));
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// VERCEL API HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // GET: Announce specific contest
    // Usage:
    //   /api/announce-winner?contestId=7              (V1 ETH contest)
    //   /api/announce-winner?contestId=2&nft=true    (V1 NFT contest)
    //   /api/announce-winner?contestId=105&v2=true   (V2 contest - explicit)
    //   /api/announce-winner?contestId=105           (V2 contest - auto-detected)
    if (req.method === 'GET') {
      const contestId = parseInt(req.query.contestId);
      const isNftContest = req.query.nft === 'true' || req.query.nft === '1';
      const isV2Contest = req.query.v2 === 'true' || req.query.v2 === '1';

      if (!contestId || isNaN(contestId)) {
        return res.status(400).json({
          error: 'Missing or invalid contestId parameter'
        });
      }

      // Auto-detect V2 if contestId >= V2_START_CONTEST_ID and not explicitly V1
      const useV2 = isV2Contest || (!isNftContest && contestId >= CONFIG.V2_START_CONTEST_ID);

      let result;
      if (useV2) {
        result = await announceV2Winners(contestId);
      } else if (isNftContest) {
        result = await announceNftWinner(contestId);
      } else {
        result = await announceWinner(contestId);
      }
      return res.status(result.success ? 200 : 400).json(result);
    }

    // POST: Check all contests (for cron)
    if (req.method === 'POST') {
      const results = await checkAndAnnounceAll();
      return res.status(200).json({
        checked: results.length,
        results
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      error: error.message
    });
  }
};

// For local testing
// Usage: node announce-winner.js [contestId] [--nft] [--v2]
if (require.main === module) {
  const args = process.argv.slice(2);
  const contestId = args.find(a => !a.startsWith('--'));
  const isNft = args.includes('--nft');
  const isV2 = args.includes('--v2');

  if (contestId) {
    const parsedId = parseInt(contestId);
    // Auto-detect V2 if contestId >= V2_START_CONTEST_ID
    const useV2 = isV2 || (!isNft && parsedId >= CONFIG.V2_START_CONTEST_ID);

    let announceFunc;
    if (useV2) {
      announceFunc = announceV2Winners;
    } else if (isNft) {
      announceFunc = announceNftWinner;
    } else {
      announceFunc = announceWinner;
    }

    announceFunc(parsedId)
      .then(result => {
        console.log('\n📊 Result:', JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      });
  } else {
    checkAndAnnounceAll()
      .then(results => {
        console.log('\n📊 Results:', JSON.stringify(results, null, 2));
        process.exit(0);
      });
  }
}
