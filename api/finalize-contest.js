/**
 * Contest Finalization API
 *
 * This endpoint checks if a contest has ended and finalizes it by:
 * 1. Fetching social engagement data from Neynar
 * 2. Fetching trading volume data (V1 only - V2 has no volume requirement)
 * 3. Filtering qualified participants
 * 4. Calling finalizeContest() on the appropriate contract
 *
 * Supports:
 * - V1 ETH prize contests (ContestEscrow)
 * - V1 NFT prize contests (NFTContestEscrow)
 * - V2 contests (ContestManager - multi-winner, no volume requirements)
 *
 * Can be called manually or via Vercel Cron
 *
 * Usage:
 *   GET /api/finalize-contest?contestId=1              (V1 ETH contest)
 *   GET /api/finalize-contest?contestId=1&nft=true     (V1 NFT contest)
 *   GET /api/finalize-contest?contestId=108&v2=true    (V2 contest - explicit)
 *   GET /api/finalize-contest?contestId=108            (V2 contest - auto-detected if >= 105)
 *   POST /api/finalize-contest (for cron - checks all pending V1 + V2 contests)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  // V1 Contract addresses (legacy)
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',

  // V2 Contract (multi-winner support) - deployed 2025-12-17
  CONTEST_MANAGER_V2: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06',
  V2_START_CONTEST_ID: 105, // V2 contests start at ID 105

  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',

  // RPC
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',

  // API Keys
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  // COVALENT_API_KEY - set in environment variables (free tier: 300K credits/month)

  // Blocked FIDs - these users cannot win contests
  BLOCKED_FIDS: [
    1188162,  // App owner - excluded from winning
  ],
};

// Contract ABIs
const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function canFinalize(uint256 _contestId) external view returns (bool)',
  'function finalizeContest(uint256 _contestId, address[] calldata _qualifiedEntries) external returns (uint256 requestId)',
  'function cancelContest(uint256 _contestId, string calldata _reason) external',
  'function nextContestId() external view returns (uint256)',
  'event ContestCreated(uint256 indexed contestId, address indexed host, address prizeToken, uint256 prizeAmount, uint256 endTime, string castId)'
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function finalizeContest(uint256 _contestId, address[] calldata _qualifiedAddresses) external returns (uint256 requestId)',
  'function cancelContest(uint256 _contestId, string calldata _reason) external',
  'function nextContestId() external view returns (uint256)',
];

// V2 ContestManager ABI - unified contest manager with multi-winner support
const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function getWinners(uint256 _contestId) external view returns (address[] memory)',
  'function canFinalize(uint256 _contestId) external view returns (bool)',
  'function finalizeContest(uint256 _contestId, address[] calldata _qualifiedAddresses) external returns (uint256 requestId)',
  'function cancelContest(uint256 _contestId, string calldata _reason) external',
  'function nextContestId() external view returns (uint256)',
];

// ═══════════════════════════════════════════════════════════════════
// HOLDER QUALIFICATION - Skip volume if user holds enough NEYNARTODES
// ═══════════════════════════════════════════════════════════════════

// Holder thresholds (in tokens with 18 decimals)
const HOLDER_THRESHOLD_DEFAULT = 100000000n * 10n**18n;  // 100M for NEYNARTODES contests
const HOLDER_THRESHOLD_CUSTOM = 200000000n * 10n**18n;   // 200M for custom token contests

/**
 * Get holder threshold based on contest type
 * Custom token contests require higher holdings to encourage trading
 */
function getHolderThreshold(tokenRequirement) {
  const isNeynartodes = tokenRequirement.toLowerCase() === CONFIG.NEYNARTODES_TOKEN.toLowerCase();
  return isNeynartodes ? HOLDER_THRESHOLD_DEFAULT : HOLDER_THRESHOLD_CUSTOM;
}

/**
 * Check if user qualifies as a holder (can skip volume requirement)
 * Sums balance across all verified addresses
 * OPTIMIZED: Fetches all balances in parallel
 */
async function checkHolderQualification(addresses, provider, tokenRequirement) {
  const threshold = getHolderThreshold(tokenRequirement);
  const thresholdFormatted = tokenRequirement.toLowerCase() === CONFIG.NEYNARTODES_TOKEN.toLowerCase()
    ? '100M' : '200M';

  const neynartodes = new ethers.Contract(
    CONFIG.NEYNARTODES_TOKEN,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  // Fetch all balances in PARALLEL instead of sequentially
  const balancePromises = addresses.map(addr =>
    neynartodes.balanceOf(addr).catch(() => 0n)
  );

  const balances = await Promise.all(balancePromises);
  const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);

  return {
    isHolder: totalBalance >= threshold,
    balance: totalBalance,
    threshold: threshold,
    thresholdFormatted: thresholdFormatted
  };
}

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API - Get Cast Engagement
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all engagements on a cast (recasts, replies, likes)
 * @param {string} castId - The cast hash/ID
 * @returns {Object} { recasters: [], repliers: [], likers: [] }
 */
async function getCastEngagement(castId) {
  try {
    // Get cast details
    const castResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${castId}&type=hash`,
      {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      }
    );

    if (!castResponse.ok) {
      console.error('Failed to fetch cast:', await castResponse.text());
      return { recasters: [], repliers: [], likers: [], usersByFid: new Map(), error: 'Cast not found' };
    }

    const castData = await castResponse.json();
    const cast = castData.cast;

    // Track users by FID to ensure 1 entry per user
    // Map: FID -> { addresses: [], liked: bool, recasted: bool, replied: bool, wordCount: number }
    const usersByFid = new Map();

    // Helper to add/update user data
    const addUserEngagement = (user, engagementType, wordCount = 0) => {
      const fid = user?.fid;
      if (!fid) return;

      // Collect ALL addresses for volume checks
      const addresses = [];
      if (user?.custody_address) {
        addresses.push(user.custody_address.toLowerCase());
      }
      if (user?.verified_addresses?.eth_addresses) {
        addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
      }

      if (addresses.length === 0) return;

      // Determine primary address for prize delivery (prefer verified over custody)
      // Priority: 1) Primary verified address, 2) First verified address, 3) Custody address
      let primaryAddress = null;
      if (user?.verified_addresses?.primary?.eth_address) {
        primaryAddress = user.verified_addresses.primary.eth_address.toLowerCase();
      } else if (user?.verified_addresses?.eth_addresses?.length > 0) {
        primaryAddress = user.verified_addresses.eth_addresses[0].toLowerCase();
      } else if (user?.custody_address) {
        primaryAddress = user.custody_address.toLowerCase();
      }

      // Get or create user entry
      let userData = usersByFid.get(fid);
      if (!userData) {
        userData = {
          fid,
          addresses: [],
          primaryAddress: primaryAddress, // Address for prize delivery
          username: user?.username || '',
          liked: false,
          recasted: false,
          replied: false,
          wordCount: 0
        };
        usersByFid.set(fid, userData);
      } else if (primaryAddress && !userData.primaryAddress) {
        // Update primary address if we didn't have one before
        userData.primaryAddress = primaryAddress;
      }

      // Add any new addresses
      for (const addr of addresses) {
        if (!userData.addresses.includes(addr)) {
          userData.addresses.push(addr);
        }
      }

      // Update engagement flags
      if (engagementType === 'like') userData.liked = true;
      if (engagementType === 'recast') userData.recasted = true;
      if (engagementType === 'reply') {
        userData.replied = true;
        userData.wordCount = Math.max(userData.wordCount, wordCount);
      }
    };

    // Get reactions (likes and recasts) with pagination
    let cursor = null;
    let pageCount = 0;
    const maxPages = 50;

    do {
      const url = cursor
        ? `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castId}&types=likes,recasts&limit=100&cursor=${cursor}`
        : `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castId}&types=likes,recasts&limit=100`;

      const reactionsResponse = await fetch(url, {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      });

      if (!reactionsResponse.ok) break;

      const reactionsData = await reactionsResponse.json();

      for (const reaction of reactionsData.reactions || []) {
        addUserEngagement(reaction.user, reaction.reaction_type);
      }

      cursor = reactionsData.cursor;
      pageCount++;

      if (cursor) await new Promise(r => setTimeout(r, 100));

    } while (cursor && pageCount < maxPages);

    console.log(`   Fetched ${pageCount} pages of reactions`);

    // Get replies with pagination
    let replyCursor = null;
    let replyPageCount = 0;

    do {
      const replyUrl = replyCursor
        ? `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castId}&type=hash&reply_depth=1&limit=50&cursor=${replyCursor}`
        : `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castId}&type=hash&reply_depth=1&limit=50`;

      const repliesResponse = await fetch(replyUrl, {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      });

      if (!repliesResponse.ok) break;

      const repliesData = await repliesResponse.json();
      const replies = repliesData.conversation?.cast?.direct_replies || [];

      for (const reply of replies) {
        const wordCount = (reply.text || '').trim().split(/\s+/).length;
        if (wordCount >= 1) {
          addUserEngagement(reply.author, 'reply', wordCount);
        }
      }

      replyCursor = repliesData.next?.cursor;
      replyPageCount++;

      if (replyCursor) await new Promise(r => setTimeout(r, 100));

    } while (replyCursor && replyPageCount < maxPages);

    console.log(`   Fetched ${replyPageCount} pages of replies`);

    // Get cast author FID to exclude from winning
    const castAuthorFid = cast.author?.fid;
    const castAuthorAddresses = [];
    if (cast.author?.custody_address) {
      castAuthorAddresses.push(cast.author.custody_address.toLowerCase());
    }
    if (cast.author?.verified_addresses?.eth_addresses) {
      castAuthorAddresses.push(...cast.author.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
    }

    // ═══════════════════════════════════════════════════════════════════
    // CHECK QUOTE CASTS USING NEYNAR QUOTES API
    // Returns ALL casts that quote the original (from any user)
    // ═══════════════════════════════════════════════════════════════════
    const quoteCasts = [];

    try {
      console.log(`   Fetching quote casts via Neynar API...`);
      const quotesResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/cast/quotes?identifier=${castId}&type=hash&limit=100`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (quotesResponse.ok) {
        const quotesData = await quotesResponse.json();
        for (const quoteCast of quotesData.casts || []) {
          if (!quoteCasts.includes(quoteCast.hash)) {
            quoteCasts.push(quoteCast.hash);
            console.log(`   Found quote cast: ${quoteCast.hash.slice(0, 10)}... by @${quoteCast.author?.username}`);
          }
        }
      }
    } catch (e) {
      console.error('   Error fetching quote casts:', e.message);
    }

    console.log(`   Found ${quoteCasts.length} quote casts to check`);

    // Get reactions AND replies on all quote casts (with pagination)
    for (const quoteHash of quoteCasts) {
      // Get reactions (likes/recasts) with pagination
      let quoteCursor = null;
      let quoteReactionCount = 0;
      do {
        const quoteReactionsUrl = quoteCursor
          ? `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${quoteHash}&types=likes,recasts&limit=100&cursor=${quoteCursor}`
          : `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${quoteHash}&types=likes,recasts&limit=100`;

        const quoteReactionsResponse = await fetch(quoteReactionsUrl, {
          headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
        });

        if (!quoteReactionsResponse.ok) break;

        const quoteReactionsData = await quoteReactionsResponse.json();
        for (const reaction of quoteReactionsData.reactions || []) {
          addUserEngagement(reaction.user, reaction.reaction_type);
          quoteReactionCount++;
        }

        quoteCursor = quoteReactionsData.cursor;
        if (quoteCursor) await new Promise(r => setTimeout(r, 100));

      } while (quoteCursor);

      console.log(`   - ${quoteHash.slice(0, 10)}...: ${quoteReactionCount} reactions`);

      // Get replies on quote cast with pagination
      let quoteReplyCursor = null;
      let quoteReplyCount = 0;
      do {
        const quoteRepliesUrl = quoteReplyCursor
          ? `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${quoteHash}&type=hash&reply_depth=1&limit=50&cursor=${quoteReplyCursor}`
          : `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${quoteHash}&type=hash&reply_depth=1&limit=50`;

        const quoteRepliesResponse = await fetch(quoteRepliesUrl, {
          headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
        });

        if (!quoteRepliesResponse.ok) break;

        const quoteRepliesData = await quoteRepliesResponse.json();
        const quoteReplies = quoteRepliesData.conversation?.cast?.direct_replies || [];

        for (const reply of quoteReplies) {
          const wordCount = (reply.text || '').trim().split(/\s+/).length;
          if (wordCount >= 1) {
            addUserEngagement(reply.author, 'reply', wordCount);
            quoteReplyCount++;
          }
        }

        quoteReplyCursor = quoteRepliesData.next?.cursor;
        if (quoteReplyCursor) await new Promise(r => setTimeout(r, 100));

      } while (quoteReplyCursor);

      if (quoteReplyCount > 0) {
        console.log(`   - ${quoteHash.slice(0, 10)}...: ${quoteReplyCount} qualifying replies`);
      }

      await new Promise(r => setTimeout(r, 100)); // Rate limit between quote casts
    }

    // Build legacy arrays for backward compatibility (addresses only)
    // These are used for logging but raffle uses usersByFid
    const likers = [];
    const recasters = [];
    const repliers = [];

    for (const [fid, userData] of usersByFid) {
      if (userData.liked) {
        likers.push(...userData.addresses);
      }
      if (userData.recasted) {
        recasters.push(...userData.addresses);
      }
      if (userData.replied) {
        for (const addr of userData.addresses) {
          repliers.push({ address: addr, wordCount: userData.wordCount });
        }
      }
    }

    return {
      recasters: [...new Set(recasters)],
      likers: [...new Set(likers)],
      repliers: repliers,
      usersByFid: usersByFid, // NEW: Map of FID -> user data for 1 entry per user
      castAuthorFid: castAuthorFid, // NEW: Author FID to exclude
      castAuthorAddresses: castAuthorAddresses
    };

  } catch (error) {
    console.error('Error fetching cast engagement:', error);
    return { recasters: [], repliers: [], likers: [], usersByFid: new Map(), error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRADING VOLUME CHECK - Direct Uniswap V2/V3/V4 Query
// ═══════════════════════════════════════════════════════════════════

// Import Uniswap volume checker
const { getUniswapVolumes } = require('./lib/uniswap-volume');

/**
 * Get trading volume for addresses on a specific token
 *
 * Uses direct Uniswap pool queries (V2, V3, V4) for accurate volume data.
 * This is called AFTER social filtering, so we only check a small subset of wallets.
 *
 * @param {string} tokenAddress - Token contract address
 * @param {string[]} addresses - Array of wallet addresses to check (already socially qualified)
 * @param {number} minVolumeUSD - Minimum USD volume required
 * @param {number} startTime - Contest start timestamp
 * @param {number} endTime - Contest end timestamp
 */
async function getTraderVolumes(tokenAddress, addresses, minVolumeUSD, startTime, endTime, contestId = null) {
  try {
    // If no volume requirement, everyone passes
    if (minVolumeUSD === 0) {
      return addresses.map(addr => ({ address: addr, volumeUSD: 0, passed: true }));
    }

    console.log(`\n💰 Checking trading volumes for ${addresses.length} socially-qualified wallets...`);

    // Set contestId globally so volume checker can use stored price
    if (contestId) {
      global._currentContestId = contestId;
    }

    // Use direct token transfer queries (catches V2, V3, V4, aggregators)
    const results = await getUniswapVolumes(
      tokenAddress,
      addresses,
      minVolumeUSD,
      startTime,
      endTime
    );

    // Clear global
    global._currentContestId = null;

    // Map results to expected format
    return results.map(r => ({
      address: r.address,
      volume: r.volumeUSD,
      volumeTokens: r.volumeTokens,
      passed: r.passed
    }));

  } catch (error) {
    console.error('Error fetching trader volumes:', error);
    // On error, fall back to token balance check
    return await fallbackVolumeCheck(tokenAddress, addresses, minVolumeUSD);
  }
}

/**
 * Fallback volume check - just checks if wallet holds the token
 * Used when Uniswap query fails
 */
async function fallbackVolumeCheck(tokenAddress, addresses, minVolumeUSD) {
  console.log('⚠️ Uniswap query failed - using token balance fallback');

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  const results = [];
  for (const address of addresses) {
    try {
      const balance = await tokenContract.balanceOf(address);
      const hasTokens = balance > 0n;
      results.push({
        address,
        volume: hasTokens ? minVolumeUSD : 0,
        passed: hasTokens || minVolumeUSD === 0
      });
    } catch (e) {
      results.push({ address, volume: 0, passed: minVolumeUSD === 0 });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN FINALIZATION LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Check and finalize a specific contest
 * @param {number} contestId - Contest ID to finalize
 * @param {boolean} isNftContest - Whether this is an NFT contest
 * @returns {Object} Result of finalization attempt
 */
async function checkAndFinalizeContest(contestId, isNftContest = false) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Need private key to call finalizeContest (owner only)
  if (!process.env.PRIVATE_KEY) {
    return { success: false, error: 'PRIVATE_KEY not configured' };
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // Use appropriate contract based on contest type
  const contractAddress = isNftContest ? CONFIG.NFT_CONTEST_ESCROW : CONFIG.CONTEST_ESCROW;
  const contractABI = isNftContest ? NFT_CONTEST_ESCROW_ABI : CONTEST_ESCROW_ABI;

  const contestEscrow = new ethers.Contract(
    contractAddress,
    contractABI,
    wallet
  );

  // Get contest details - different structure for NFT vs ETH contests
  const contest = await contestEscrow.getContest(contestId);

  let host, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner;

  if (isNftContest) {
    // NFT: host, nftType, nftContract, tokenId, amount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner
    [host, , , , , startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;
  } else {
    // ETH: host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner
    [host, , , startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;
  }

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 0n) {
    return {
      success: false,
      error: `Contest not active (status: ${status})`,
      contestId
    };
  }

  // Check if contest has ended
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(endTime)) {
    return {
      success: false,
      error: `Contest not ended yet (ends: ${new Date(Number(endTime) * 1000).toISOString()})`,
      contestId
    };
  }

  console.log(`\n📋 Processing ${isNftContest ? 'NFT' : 'ETH'} Contest #${contestId}`);
  console.log(`   Cast ID (raw): ${castId}`);
  console.log(`   Token Requirement: ${tokenRequirement}`);
  console.log(`   Volume Requirement: ${ethers.formatEther(volumeRequirement)} tokens`);

  // Extract actual cast hash (strip requirements if encoded)
  // Format: "0xcasthash|R1L0P1" -> "0xcasthash"
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
  console.log(`   Actual Cast Hash: ${actualCastHash}`);

  // Get social engagement
  console.log('\n🔍 Fetching social engagement from Neynar...');
  const engagement = await getCastEngagement(actualCastHash);

  if (engagement.error) {
    console.log(`   ⚠️ Could not fetch cast: ${engagement.error}`);
    // If cast not found, we can't determine participants
    return {
      success: false,
      error: `Cast not found: ${castId}`,
      contestId
    };
  }

  // Count unique users (by FID)
  const uniqueUsers = engagement.usersByFid ? engagement.usersByFid.size : 0;
  const likerCount = engagement.usersByFid ? [...engagement.usersByFid.values()].filter(u => u.liked).length : 0;
  const recasterCount = engagement.usersByFid ? [...engagement.usersByFid.values()].filter(u => u.recasted).length : 0;
  const replierCount = engagement.usersByFid ? [...engagement.usersByFid.values()].filter(u => u.replied).length : 0;

  console.log(`   Unique users: ${uniqueUsers}`);
  console.log(`   Recasters: ${recasterCount} users (${engagement.recasters.length} addresses)`);
  console.log(`   Repliers (2+ words): ${replierCount} users`);
  console.log(`   Likers: ${likerCount} users (${engagement.likers.length} addresses)`);

  // ═══════════════════════════════════════════════════════════════════
  // SOCIAL REQUIREMENTS - Parse from castId
  // Format: "castHash|R1L0P1" where R=recast, L=like, P=reply (1=required, 0=not)
  // If no pipe delimiter, use defaults (recast + reply required)
  // ═══════════════════════════════════════════════════════════════════
  let socialRequirements = {
    requireRecast: true,    // Default: must recast
    requireReply: true,     // Default: must reply (2-word minimum)
    requireLike: false,     // Default: like not required
  };

  // Parse requirements from castId if encoded
  if (castId.includes('|')) {
    const [, reqCode] = castId.split('|');
    if (reqCode) {
      // Parse R1L0P1 format
      const recastMatch = reqCode.match(/R(\d)/);
      const likeMatch = reqCode.match(/L(\d)/);
      const replyMatch = reqCode.match(/P(\d)/);

      if (recastMatch) socialRequirements.requireRecast = recastMatch[1] !== '0';
      if (likeMatch) socialRequirements.requireLike = likeMatch[1] !== '0';
      if (replyMatch) socialRequirements.requireReply = replyMatch[1] !== '0';

      console.log(`   Parsed requirements from castId: R=${socialRequirements.requireRecast ? 1 : 0} L=${socialRequirements.requireLike ? 1 : 0} P=${socialRequirements.requireReply ? 1 : 0}`);
    }
  }

  console.log(`   Requirements: Recast=${socialRequirements.requireRecast}, Like=${socialRequirements.requireLike}, Reply=${socialRequirements.requireReply}`);

  // ═══════════════════════════════════════════════════════════════════
  // FILTER QUALIFIED USERS BY FID (1 entry per user)
  // Each user gets 1 raffle entry, but we check ALL their addresses for volume
  // ═══════════════════════════════════════════════════════════════════
  const qualifiedUsers = []; // Array of { fid, addresses, primaryAddress }

  for (const [fid, userData] of engagement.usersByFid || new Map()) {
    // Skip the contest host
    if (fid === engagement.castAuthorFid) continue;

    // Skip blocked FIDs (e.g., app owner)
    if (CONFIG.BLOCKED_FIDS.includes(fid)) {
      console.log(`   Skipping blocked FID: ${fid} (@${userData.username})`);
      continue;
    }

    // Check if user meets social requirements
    let meetsRequirements = true;

    if (socialRequirements.requireRecast && !userData.recasted) {
      meetsRequirements = false;
    }
    if (socialRequirements.requireLike && !userData.liked) {
      meetsRequirements = false;
    }
    if (socialRequirements.requireReply && !userData.replied) {
      meetsRequirements = false;
    }

    // If no requirements set, any engagement qualifies
    if (!socialRequirements.requireRecast && !socialRequirements.requireLike && !socialRequirements.requireReply) {
      meetsRequirements = userData.liked || userData.recasted || userData.replied;
    }

    if (meetsRequirements && userData.addresses.length > 0) {
      // Use primaryAddress (verified wallet) for raffle entry, fallback to first address
      const prizeAddress = userData.primaryAddress || userData.addresses[0];
      qualifiedUsers.push({
        fid: userData.fid,
        username: userData.username,
        addresses: userData.addresses, // All addresses for volume check
        primaryAddress: prizeAddress // Verified address for raffle entry (prize delivery)
      });
    }
  }

  console.log(`\n✅ Qualified users: ${qualifiedUsers.length} (1 entry per FID)`);

  // Build flat list of all addresses for volume checking
  let potentialParticipants = [];
  for (const user of qualifiedUsers) {
    potentialParticipants.push(...user.addresses);
  }
  potentialParticipants = [...new Set(potentialParticipants)];

  if (potentialParticipants.length === 0) {
    // No qualified participants - auto-cancel and refund host
    console.log('\n❌ No qualified participants - cancelling contest and refunding host...');
    try {
      const tx = await contestEscrow.cancelContest(contestId, 'No qualified participants');
      console.log(`   TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`   ✅ Contest cancelled, host refunded in block ${receipt.blockNumber}`);
      return {
        success: true,
        contestId,
        action: 'cancelled',
        reason: 'No qualified participants (no one did recast + 2-word reply)',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      console.error('   ❌ Cancel failed:', cancelError.message);
      return {
        success: false,
        error: `Cancel failed: ${cancelError.message}`,
        contestId
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HOLDER + VOLUME QUALIFICATION
  // Holders (100M+ NEYNARTODES, or 200M+ for custom token contests) skip volume
  // Non-holders must meet the volume requirement
  // ═══════════════════════════════════════════════════════════════════
  let finalQualifiedUsers = [...qualifiedUsers]; // Users who pass all requirements

  if (volumeRequirement > 0n) {
    const thresholdFormatted = tokenRequirement.toLowerCase() === CONFIG.NEYNARTODES_TOKEN.toLowerCase()
      ? '100M' : '200M';

    console.log(`\n💎 Checking holder status (${thresholdFormatted} $NEYNARTODES threshold)...`);

    // First pass: check holder status for all users IN PARALLEL
    // Batch into chunks of 10 to avoid rate limiting
    const BATCH_SIZE = 10;
    const holderUsers = [];
    const nonHolderUsers = [];

    for (let i = 0; i < qualifiedUsers.length; i += BATCH_SIZE) {
      const batch = qualifiedUsers.slice(i, i + BATCH_SIZE);
      const holderChecks = await Promise.all(
        batch.map(user => checkHolderQualification(user.addresses, provider, tokenRequirement))
      );

      batch.forEach((user, idx) => {
        const holderCheck = holderChecks[idx];
        if (holderCheck.isHolder) {
          holderUsers.push(user);
          console.log(`   💎 @${user.username || user.fid} is a HOLDER (${ethers.formatEther(holderCheck.balance)} tokens)`);
        } else {
          nonHolderUsers.push(user);
        }
      });
    }

    console.log(`   Holders (skip volume): ${holderUsers.length}`);
    console.log(`   Non-holders (need volume check): ${nonHolderUsers.length}`);

    // Second pass: check volume for non-holders only
    if (nonHolderUsers.length > 0) {
      console.log('\n💰 Checking trading volumes for non-holders...');

      // Get all addresses from non-holder users
      const nonHolderAddresses = [];
      for (const user of nonHolderUsers) {
        nonHolderAddresses.push(...user.addresses);
      }
      const uniqueNonHolderAddresses = [...new Set(nonHolderAddresses)];

      const volumeResults = await getTraderVolumes(
        tokenRequirement,
        uniqueNonHolderAddresses,
        Number(ethers.formatEther(volumeRequirement)),
        Number(startTime),
        Number(endTime),
        contestId
      );

      // Build set of addresses that passed volume check
      const passedAddresses = new Set(
        volumeResults.filter(r => r.passed).map(r => r.address)
      );

      // Filter non-holders: keep only those who passed volume check
      const volumeQualifiedUsers = nonHolderUsers.filter(user => {
        const hasPassingAddress = user.addresses.some(addr => passedAddresses.has(addr));
        if (hasPassingAddress) {
          const passingAddr = user.addresses.find(addr => passedAddresses.has(addr));
          if (passingAddr) user.primaryAddress = passingAddr;
        }
        return hasPassingAddress;
      });

      console.log(`   Passed volume check: ${volumeQualifiedUsers.length}/${nonHolderUsers.length} non-holders`);

      // Combine holders + volume-qualified non-holders
      finalQualifiedUsers = [...holderUsers, ...volumeQualifiedUsers];
    } else {
      // All qualified users are holders
      finalQualifiedUsers = holderUsers;
    }

    console.log(`\n✅ Total qualified: ${finalQualifiedUsers.length} (${holderUsers.length} holders + ${finalQualifiedUsers.length - holderUsers.length} traders)`);
  }

  if (finalQualifiedUsers.length === 0) {
    // No one qualified (neither holders nor traders) - auto-cancel and refund host
    console.log('\n❌ No participants qualified (no holders or traders) - cancelling contest and refunding host...');
    try {
      const tx = await contestEscrow.cancelContest(contestId, 'No participants met volume requirement');
      console.log(`   TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`   ✅ Contest cancelled, host refunded in block ${receipt.blockNumber}`);
      return {
        success: true,
        contestId,
        action: 'cancelled',
        reason: 'No participants met volume requirement',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      console.error('   ❌ Cancel failed:', cancelError.message);
      return {
        success: false,
        error: `Cancel failed: ${cancelError.message}`,
        contestId
      };
    }
  }

  // Build final entries: 1 primary address per qualified user (1 entry per FID)
  // BONUS: Users who replied with 2+ words get a second entry
  const qualifiedAddresses = [];

  for (const user of finalQualifiedUsers) {
    // First entry for everyone
    qualifiedAddresses.push(user.primaryAddress);

    // Check if this user replied with 2+ words from the engagement data
    const userData = engagement.usersByFid?.get(user.fid);
    if (userData && userData.replied && userData.wordCount >= 2) {
      // Bonus entry for reply!
      qualifiedAddresses.push(user.primaryAddress);
      console.log(`   🎁 Bonus entry for @${user.username || user.fid} (replied with ${userData.wordCount} words)`);
    }
  }

  const bonusEntries = qualifiedAddresses.length - finalQualifiedUsers.length;
  if (bonusEntries > 0) {
    console.log(`   📝 Added ${bonusEntries} bonus entries for replies`);
  }

  // Finalize contest on-chain
  // Limit entries to avoid gas limit errors
  // Each address uses ~2100 gas for storage, limit to 1000 to stay under 30M gas limit
  const MAX_ENTRIES = 1000;
  let finalEntries = qualifiedAddresses;

  if (qualifiedAddresses.length > MAX_ENTRIES) {
    console.log(`\n⚠️ Too many entries (${qualifiedAddresses.length}), randomly sampling ${MAX_ENTRIES}...`);
    // Shuffle and take first MAX_ENTRIES (fair random selection)
    const shuffled = [...qualifiedAddresses].sort(() => Math.random() - 0.5);
    finalEntries = shuffled.slice(0, MAX_ENTRIES);
  }

  console.log(`\n🎲 Finalizing contest with ${finalEntries.length} entries (1 per user)...`);

  try {
    const tx = await contestEscrow.finalizeContest(contestId, finalEntries);
    console.log(`   TX submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    // Store the finalize TX hash in KV for announcement
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        const kvKey = isNftContest ? `finalize_tx_nft_${contestId}` : `finalize_tx_${contestId}`;
        await kv.set(kvKey, tx.hash);
        console.log(`   📝 Stored finalize TX hash in KV (${kvKey})`);
      }
    } catch (e) {
      console.log(`   Could not store TX hash:`, e.message);
    }

    // Poll for winner (VRF callback usually takes 1-3 blocks on Base)
    console.log('\n⏳ Waiting for Chainlink VRF to select winner...');
    let winner = '0x0000000000000000000000000000000000000000';
    let attempts = 0;
    const maxAttempts = 30; // ~60 seconds max wait

    while (winner === '0x0000000000000000000000000000000000000000' && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds
      attempts++;

      try {
        const updatedContest = await contestEscrow.getContest(contestId);
        winner = updatedContest[9]; // winner is index 9
        const status = updatedContest[8];

        if (status === 2n && winner !== '0x0000000000000000000000000000000000000000') {
          console.log(`   ✅ Winner selected: ${winner}`);
          break;
        }
        console.log(`   Attempt ${attempts}/${maxAttempts} - waiting for VRF...`);
      } catch (e) {
        console.log(`   Attempt ${attempts} error: ${e.message}`);
      }
    }

    // Auto-announce winner if found
    if (winner !== '0x0000000000000000000000000000000000000000') {
      console.log('\n📢 Auto-announcing winner...');
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000';

        const announceResponse = await fetch(`${baseUrl}/api/announce-winner?contestId=${contestId}`);
        const announceResult = await announceResponse.json();

        if (announceResult.posted) {
          console.log(`   ✅ Winner announcement posted! Cast: ${announceResult.castHash}`);
        } else {
          console.log(`   ⚠️ Announcement created but not posted: ${announceResult.note || 'Unknown reason'}`);
        }

        return {
          success: true,
          contestId,
          qualifiedCount: qualifiedAddresses.length,
          txHash: receipt.hash,
          winner,
          announced: announceResult.posted,
          announceCastHash: announceResult.castHash,
          message: 'Contest finalized and winner announced!'
        };
      } catch (announceError) {
        console.log(`   ⚠️ Auto-announce failed: ${announceError.message}`);
      }
    }

    return {
      success: true,
      contestId,
      qualifiedCount: qualifiedAddresses.length,
      txHash: receipt.hash,
      winner: winner !== '0x0000000000000000000000000000000000000000' ? winner : null,
      message: winner !== '0x0000000000000000000000000000000000000000'
        ? 'Contest finalized! Winner selected.'
        : 'Contest finalized! Chainlink VRF will select winner shortly.'
    };

  } catch (error) {
    console.error('   ❌ Finalization failed:', error.message);
    return {
      success: false,
      error: error.message,
      contestId
    };
  }
}

/**
 * Check and finalize a V2 ContestManager contest
 * V2 contests are simpler - no volume/token requirements, just social engagement
 * Supports multiple winners
 * @param {number} contestId - Contest ID to finalize
 * @returns {Object} Result of finalization attempt
 */
async function checkAndFinalizeV2Contest(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Need private key to call finalizeContest (owner only)
  if (!process.env.PRIVATE_KEY) {
    return { success: false, error: 'PRIVATE_KEY not configured', isV2: true };
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const contestManager = new ethers.Contract(
    CONFIG.CONTEST_MANAGER_V2,
    CONTEST_MANAGER_V2_ABI,
    wallet
  );

  // Get contest details
  // V2: host, contestType, status, castId, endTime, prizeToken, prizeAmount, winnerCount, winners
  const contest = await contestManager.getContest(contestId);
  const [host, contestType, status, castId, endTime, prizeToken, prizeAmount, winnerCount, winners] = contest;

  // Contest types: 0=ETH, 1=ERC20, 2=NFT
  const contestTypeNames = ['ETH', 'ERC20', 'NFT'];
  const typeName = contestTypeNames[Number(contestType)] || 'Unknown';

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 0n) {
    return {
      success: false,
      error: `V2 Contest not active (status: ${status})`,
      contestId,
      isV2: true
    };
  }

  // Check if contest has ended
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(endTime)) {
    return {
      success: false,
      error: `V2 Contest not ended yet (ends: ${new Date(Number(endTime) * 1000).toISOString()})`,
      contestId,
      isV2: true
    };
  }

  console.log(`\n📋 Processing V2 ${typeName} Contest #${contestId}`);
  console.log(`   Host: ${host}`);
  console.log(`   Cast ID (raw): ${castId}`);
  console.log(`   Winner Count: ${winnerCount}`);
  console.log(`   Prize: ${ethers.formatEther(prizeAmount)} ${typeName === 'ETH' ? 'ETH' : 'tokens'}`);

  // Extract actual cast hash (strip requirements if encoded)
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
  console.log(`   Actual Cast Hash: ${actualCastHash}`);

  // Get social engagement
  console.log('\n🔍 Fetching social engagement from Neynar...');
  const engagement = await getCastEngagement(actualCastHash);

  if (engagement.error) {
    console.log(`   ⚠️ Could not fetch cast: ${engagement.error}`);
    return {
      success: false,
      error: `Cast not found: ${castId}`,
      contestId,
      isV2: true
    };
  }

  // Parse social requirements from castId (format: "hash|R1L0P1")
  let socialRequirements = {
    requireRecast: true,
    requireReply: true,
    requireLike: false,
  };

  if (castId.includes('|')) {
    const [, reqCode] = castId.split('|');
    if (reqCode) {
      const recastMatch = reqCode.match(/R(\d)/);
      const likeMatch = reqCode.match(/L(\d)/);
      const replyMatch = reqCode.match(/P(\d)/);

      if (recastMatch) socialRequirements.requireRecast = recastMatch[1] !== '0';
      if (likeMatch) socialRequirements.requireLike = likeMatch[1] !== '0';
      if (replyMatch) socialRequirements.requireReply = replyMatch[1] !== '0';

      console.log(`   Parsed requirements: R=${socialRequirements.requireRecast ? 1 : 0} L=${socialRequirements.requireLike ? 1 : 0} P=${socialRequirements.requireReply ? 1 : 0}`);
    }
  }

  // Count unique users
  const uniqueUsers = engagement.usersByFid ? engagement.usersByFid.size : 0;
  console.log(`   Unique users engaged: ${uniqueUsers}`);

  // Get cast author FID to exclude from winning
  const castAuthorFid = engagement.castAuthorFid;

  // Filter qualified users by FID (1 entry per user)
  // V2 doesn't have volume requirements - all social qualifiers are eligible
  const qualifiedUsers = [];

  for (const [fid, userData] of engagement.usersByFid || new Map()) {
    // Skip the contest host
    if (fid === castAuthorFid) continue;

    // Skip blocked FIDs
    if (CONFIG.BLOCKED_FIDS.includes(fid)) {
      console.log(`   Skipping blocked FID: ${fid} (@${userData.username})`);
      continue;
    }

    // Check if user meets social requirements
    let meetsRequirements = true;

    if (socialRequirements.requireRecast && !userData.recasted) {
      meetsRequirements = false;
    }
    if (socialRequirements.requireLike && !userData.liked) {
      meetsRequirements = false;
    }
    if (socialRequirements.requireReply && !userData.replied) {
      meetsRequirements = false;
    }

    // If no requirements set, any engagement qualifies
    if (!socialRequirements.requireRecast && !socialRequirements.requireLike && !socialRequirements.requireReply) {
      meetsRequirements = userData.liked || userData.recasted || userData.replied;
    }

    if (meetsRequirements && userData.addresses.length > 0) {
      const prizeAddress = userData.primaryAddress || userData.addresses[0];
      qualifiedUsers.push({
        fid: userData.fid,
        username: userData.username,
        addresses: userData.addresses,
        primaryAddress: prizeAddress
      });
    }
  }

  console.log(`\n✅ Qualified users: ${qualifiedUsers.length} (1 entry per FID)`);

  if (qualifiedUsers.length === 0) {
    // No qualified participants - auto-cancel and refund host
    console.log('\n❌ No qualified participants - cancelling V2 contest and refunding host...');
    try {
      const tx = await contestManager.cancelContest(contestId, 'No qualified participants');
      console.log(`   TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`   ✅ V2 Contest cancelled, host refunded in block ${receipt.blockNumber}`);
      return {
        success: true,
        contestId,
        isV2: true,
        action: 'cancelled',
        reason: 'No qualified participants',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      console.error('   ❌ Cancel failed:', cancelError.message);
      return {
        success: false,
        error: `Cancel failed: ${cancelError.message}`,
        contestId,
        isV2: true
      };
    }
  }

  // Build final entries: 1 primary address per qualified user
  // Bonus: Users who replied with 2+ words get a second entry
  const qualifiedAddresses = [];

  for (const user of qualifiedUsers) {
    qualifiedAddresses.push(user.primaryAddress);

    const userData = engagement.usersByFid?.get(user.fid);
    if (userData && userData.replied && userData.wordCount >= 2) {
      qualifiedAddresses.push(user.primaryAddress);
      console.log(`   🎁 Bonus entry for @${user.username || user.fid} (replied with ${userData.wordCount} words)`);
    }
  }

  const bonusEntries = qualifiedAddresses.length - qualifiedUsers.length;
  if (bonusEntries > 0) {
    console.log(`   📝 Added ${bonusEntries} bonus entries for replies`);
  }

  // Limit entries to avoid gas limit errors
  const MAX_ENTRIES = 1000;
  let finalEntries = qualifiedAddresses;

  if (qualifiedAddresses.length > MAX_ENTRIES) {
    console.log(`\n⚠️ Too many entries (${qualifiedAddresses.length}), randomly sampling ${MAX_ENTRIES}...`);
    const shuffled = [...qualifiedAddresses].sort(() => Math.random() - 0.5);
    finalEntries = shuffled.slice(0, MAX_ENTRIES);
  }

  console.log(`\n🎲 Finalizing V2 contest with ${finalEntries.length} entries (${winnerCount} winners)...`);

  try {
    const tx = await contestManager.finalizeContest(contestId, finalEntries);
    console.log(`   TX submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    // Store the finalize TX hash in KV for announcement
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        await kv.set(`finalize_tx_v2_${contestId}`, tx.hash);
        console.log(`   📝 Stored finalize TX hash in KV (finalize_tx_v2_${contestId})`);
      }
    } catch (e) {
      console.log(`   Could not store TX hash:`, e.message);
    }

    // Poll for winners (VRF callback usually takes 1-3 blocks on Base)
    console.log('\n⏳ Waiting for Chainlink VRF to select winners...');
    let selectedWinners = [];
    let attempts = 0;
    const maxAttempts = 30;

    while (selectedWinners.length === 0 && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;

      try {
        const updatedContest = await contestManager.getContest(contestId);
        const updatedStatus = updatedContest[2];
        selectedWinners = updatedContest[8];

        if (updatedStatus === 2n && selectedWinners.length > 0) {
          console.log(`   ✅ ${selectedWinners.length} winner(s) selected!`);
          for (const w of selectedWinners) {
            console.log(`      - ${w}`);
          }
          break;
        }
        console.log(`   Attempt ${attempts}/${maxAttempts} - waiting for VRF...`);
      } catch (e) {
        console.log(`   Attempt ${attempts} error: ${e.message}`);
      }
    }

    // Auto-announce winners if found
    if (selectedWinners.length > 0) {
      console.log('\n📢 Auto-announcing winners...');
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000';

        const announceResponse = await fetch(`${baseUrl}/api/announce-winner?contestId=${contestId}&v2=true`);
        const announceResult = await announceResponse.json();

        if (announceResult.posted) {
          console.log(`   ✅ Winner announcement posted! Cast: ${announceResult.castHash}`);
        } else {
          console.log(`   ⚠️ Announcement created but not posted: ${announceResult.note || 'Unknown reason'}`);
        }

        return {
          success: true,
          contestId,
          isV2: true,
          qualifiedCount: qualifiedAddresses.length,
          txHash: receipt.hash,
          winners: selectedWinners,
          announced: announceResult.posted,
          announceCastHash: announceResult.castHash,
          message: 'V2 Contest finalized and winners announced!'
        };
      } catch (announceError) {
        console.log(`   ⚠️ Auto-announce failed: ${announceError.message}`);
      }
    }

    return {
      success: true,
      contestId,
      isV2: true,
      qualifiedCount: qualifiedAddresses.length,
      txHash: receipt.hash,
      winners: selectedWinners.length > 0 ? selectedWinners : null,
      message: selectedWinners.length > 0
        ? 'V2 Contest finalized! Winners selected.'
        : 'V2 Contest finalized! Chainlink VRF will select winners shortly.'
    };

  } catch (error) {
    console.error('   ❌ V2 Finalization failed:', error.message);
    return {
      success: false,
      error: error.message,
      contestId,
      isV2: true
    };
  }
}

/**
 * Check all pending contests and finalize any that have ended
 * Checks V1 ETH, V1 NFT, and V2 ContestManager contests
 */
async function checkAllPendingContests() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const results = [];

  // Check ETH contests
  const ethEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const ethNextId = await ethEscrow.nextContestId();
  const MAX_CONTESTS_TO_CHECK = 15n;
  const ethStartId = ethNextId > MAX_CONTESTS_TO_CHECK ? ethNextId - MAX_CONTESTS_TO_CHECK : 1n;

  console.log(`\n🔍 Checking ETH contests ${ethStartId} to ${ethNextId - 1n}...`);

  for (let i = ethStartId; i < ethNextId; i++) {
    try {
      const canFinalize = await ethEscrow.canFinalize(i);

      if (canFinalize) {
        console.log(`\n📋 ETH Contest #${i} is ready to finalize`);
        const result = await checkAndFinalizeContest(Number(i), false);
        results.push(result);
      }
    } catch (e) {
      console.log(`   Skipping ETH contest #${i}: ${e.message?.slice(0, 50) || 'unknown error'}`);
      continue;
    }
  }

  // Check NFT contests
  const nftEscrow = new ethers.Contract(
    CONFIG.NFT_CONTEST_ESCROW,
    NFT_CONTEST_ESCROW_ABI,
    provider
  );

  const nftNextId = await nftEscrow.nextContestId();
  const nftStartId = nftNextId > MAX_CONTESTS_TO_CHECK ? nftNextId - MAX_CONTESTS_TO_CHECK : 1n;

  console.log(`\n🔍 Checking NFT contests ${nftStartId} to ${nftNextId - 1n}...`);

  for (let i = nftStartId; i < nftNextId; i++) {
    try {
      // NFT contract doesn't have canFinalize, so check status and endTime manually
      const contest = await nftEscrow.getContest(i);
      const status = contest[10]; // status is at index 10 for NFT contests
      const endTime = contest[6]; // endTime is at index 6

      const now = Math.floor(Date.now() / 1000);
      const canFinalize = status === 0n && now >= Number(endTime);

      if (canFinalize) {
        console.log(`\n📋 NFT Contest #${i} is ready to finalize`);
        const result = await checkAndFinalizeContest(Number(i), true);
        results.push(result);
      }
    } catch (e) {
      console.log(`   Skipping NFT contest #${i}: ${e.message?.slice(0, 50) || 'unknown error'}`);
      continue;
    }
  }

  // Check V2 ContestManager contests
  try {
    const v2Manager = new ethers.Contract(
      CONFIG.CONTEST_MANAGER_V2,
      CONTEST_MANAGER_V2_ABI,
      provider
    );

    const v2NextId = await v2Manager.nextContestId();
    const v2StartId = v2NextId > MAX_CONTESTS_TO_CHECK ? v2NextId - MAX_CONTESTS_TO_CHECK : BigInt(CONFIG.V2_START_CONTEST_ID);

    if (v2NextId > v2StartId) {
      console.log(`\n🔍 Checking V2 contests ${v2StartId} to ${v2NextId - 1n}...`);

      for (let i = v2StartId; i < v2NextId; i++) {
        try {
          const canFinalize = await v2Manager.canFinalize(i);

          if (canFinalize) {
            console.log(`\n📋 V2 Contest #${i} is ready to finalize`);
            const result = await checkAndFinalizeV2Contest(Number(i));
            results.push(result);
          }
        } catch (e) {
          console.log(`   Skipping V2 contest #${i}: ${e.message?.slice(0, 50) || 'unknown error'}`);
          continue;
        }
      }
    } else {
      console.log(`\n🔍 No V2 contests to check (next ID: ${v2NextId})`);
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
    // GET: Finalize specific contest
    // Usage:
    //   /api/finalize-contest?contestId=1              (V1 ETH contest)
    //   /api/finalize-contest?contestId=1&nft=true     (V1 NFT contest)
    //   /api/finalize-contest?contestId=108&v2=true    (V2 contest - explicit)
    //   /api/finalize-contest?contestId=108            (V2 contest - auto-detected if >= V2_START_CONTEST_ID)
    if (req.method === 'GET') {
      const contestId = parseInt(req.query.contestId);
      const isNftContest = req.query.nft === 'true' || req.query.nft === '1';
      const isV2Contest = req.query.v2 === 'true' || req.query.v2 === '1';

      if (!contestId || isNaN(contestId)) {
        return res.status(400).json({
          error: 'Missing or invalid contestId parameter'
        });
      }

      // Auto-detect V2 if contestId >= V2_START_CONTEST_ID and not explicitly V1 (nft flag)
      const useV2 = isV2Contest || (!isNftContest && contestId >= CONFIG.V2_START_CONTEST_ID);

      let result;
      if (useV2) {
        result = await checkAndFinalizeV2Contest(contestId);
      } else {
        result = await checkAndFinalizeContest(contestId, isNftContest);
      }
      return res.status(result.success ? 200 : 400).json(result);
    }

    // POST: Check all pending contests (for cron)
    if (req.method === 'POST') {
      // Verify cron secret if configured
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const results = await checkAllPendingContests();
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
if (require.main === module) {
  const contestId = process.argv[2];

  if (contestId) {
    checkAndFinalizeContest(parseInt(contestId))
      .then(result => {
        console.log('\n📊 Result:', JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      });
  } else {
    checkAllPendingContests()
      .then(results => {
        console.log('\n📊 Results:', JSON.stringify(results, null, 2));
        process.exit(0);
      });
  }
}
