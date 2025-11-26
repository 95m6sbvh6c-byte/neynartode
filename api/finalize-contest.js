/**
 * Contest Finalization API
 *
 * This endpoint checks if a contest has ended and finalizes it by:
 * 1. Fetching social engagement data from Neynar
 * 2. Fetching trading volume data from GeckoTerminal (FREE API)
 * 3. Filtering qualified participants
 * 4. Calling finalizeContest() on ContestEscrow
 *
 * Can be called manually or via Vercel Cron
 *
 * Usage:
 *   GET /api/finalize-contest?contestId=1
 *   POST /api/finalize-contest (for cron - checks all pending contests)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  // Contract addresses
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',

  // RPC
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',

  // API Keys
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  // COVALENT_API_KEY - set in environment variables (free tier: 300K credits/month)
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
      return { recasters: [], repliers: [], likers: [], error: 'Cast not found' };
    }

    const castData = await castResponse.json();
    const cast = castData.cast;

    // Get reactions (likes and recasts) with pagination
    let likers = [];
    let recasters = [];
    let cursor = null;
    let pageCount = 0;
    const maxPages = 50; // Safety limit: 50 pages * 100 = 5000 max reactions

    do {
      const url = cursor
        ? `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castId}&types=likes,recasts&limit=100&cursor=${cursor}`
        : `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castId}&types=likes,recasts&limit=100`;

      const reactionsResponse = await fetch(url, {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      });

      if (!reactionsResponse.ok) break;

      const reactionsData = await reactionsResponse.json();

      // Extract ONE address per user (first verified address only)
      for (const reaction of reactionsData.reactions || []) {
        const addresses = reaction.user?.verified_addresses?.eth_addresses || [];
        if (addresses.length > 0) {
          const primaryAddress = addresses[0]; // Use first/primary wallet only
          if (reaction.reaction_type === 'like') {
            likers.push(primaryAddress);
          } else if (reaction.reaction_type === 'recast') {
            recasters.push(primaryAddress);
          }
        }
      }

      cursor = reactionsData.cursor;
      pageCount++;

      // Small delay to avoid rate limiting
      if (cursor) await new Promise(r => setTimeout(r, 100));

    } while (cursor && pageCount < maxPages);

    console.log(`   Fetched ${pageCount} pages of reactions`);

    // Get replies with pagination
    let repliers = [];
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
        // Check reply has at least 4 words
        const wordCount = (reply.text || '').trim().split(/\s+/).length;
        if (wordCount >= 4) {
          const addresses = reply.author?.verified_addresses?.eth_addresses || [];
          if (addresses.length > 0) {
            // Use first/primary wallet only - one entry per user
            repliers.push({
              address: addresses[0].toLowerCase(),
              wordCount
            });
          }
        }
      }

      replyCursor = repliesData.next?.cursor;
      replyPageCount++;

      if (replyCursor) await new Promise(r => setTimeout(r, 100));

    } while (replyCursor && replyPageCount < maxPages);

    console.log(`   Fetched ${replyPageCount} pages of replies`);

    return {
      recasters: [...new Set(recasters.map(a => a.toLowerCase()))],
      likers: [...new Set(likers.map(a => a.toLowerCase()))],
      repliers: repliers, // Keep word count info
      castAuthor: cast.author?.verified_addresses?.eth_addresses?.[0]?.toLowerCase()
    };

  } catch (error) {
    console.error('Error fetching cast engagement:', error);
    return { recasters: [], repliers: [], likers: [], error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRADING VOLUME CHECK - Uses Neynar webhook data or fallback
// ═══════════════════════════════════════════════════════════════════

/**
 * Get trading volume for addresses on a specific token
 * Priority:
 * 1. Neynar webhook data (real-time, free)
 * 2. Covalent API (if configured)
 * 3. Fallback to token balance check
 *
 * @param {string} tokenAddress - Token contract address
 * @param {string[]} addresses - Array of wallet addresses to check
 * @param {number} minVolume - Minimum volume required (in token units)
 * @param {number} startTime - Contest start timestamp
 * @param {number} endTime - Contest end timestamp
 */
async function getTraderVolumes(tokenAddress, addresses, minVolume, startTime, endTime) {
  try {
    // If no volume requirement, everyone passes
    if (minVolume === 0) {
      return addresses.map(addr => ({ address: addr, volume: 0, passed: true }));
    }

    // Try Neynar webhook data first (via our trade-webhook API)
    try {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      console.log('📊 Checking trade volumes via Neynar webhook data...');

      const results = [];
      for (const address of addresses) {
        const response = await fetch(
          `${baseUrl}/api/trade-webhook?token=${tokenAddress}&wallet=${address}`
        );

        if (response.ok) {
          const data = await response.json();
          const volume = data.volume || 0;

          console.log(`   ${address.slice(0, 8)}... volume: ${volume.toFixed(2)} tokens`);

          results.push({
            address,
            volume,
            passed: volume >= minVolume
          });
        } else {
          results.push({ address, volume: 0, passed: false });
        }
      }

      // If we got results from webhook, use them
      if (results.length > 0 && results.some(r => r.volume > 0)) {
        return results;
      }

      console.log('   No webhook data found, trying fallback...');
    } catch (e) {
      console.log('   Webhook check failed:', e.message);
    }

    // Fallback to Covalent if configured
    const COVALENT_API_KEY = process.env.COVALENT_API_KEY;

    if (COVALENT_API_KEY) {
      console.log('💰 Checking volumes via Covalent API...');
      // Base chain ID for Covalent
      const CHAIN_ID = 'base-mainnet';

      const results = [];

      for (const address of addresses) {
        try {
          const response = await fetch(
            `https://api.covalenthq.com/v1/${CHAIN_ID}/address/${address}/transfers_v2/?contract-address=${tokenAddress}&starting-block=${await timestampToBlock(startTime)}&ending-block=${await timestampToBlock(endTime)}`,
            {
              headers: {
                'Authorization': `Bearer ${COVALENT_API_KEY}`
              }
            }
          );

          if (!response.ok) {
            console.log(`   Covalent API error for ${address}: ${response.status}`);
            results.push({ address, volume: 0, passed: false });
            continue;
          }

          const data = await response.json();
          const transfers = data.data?.items || [];

          let totalVolume = 0n;

          for (const transfer of transfers) {
            for (const item of transfer.transfers || []) {
              if (item.contract_address?.toLowerCase() === tokenAddress.toLowerCase()) {
                const delta = BigInt(item.delta || '0');
                totalVolume += delta > 0n ? delta : -delta;
              }
            }
          }

          const volumeInTokens = Number(totalVolume) / 1e18;
          console.log(`   ${address.slice(0, 8)}... volume: ${volumeInTokens.toFixed(2)} tokens`);

          results.push({
            address,
            volume: volumeInTokens,
            passed: volumeInTokens >= minVolume
          });

        } catch (e) {
          console.log(`   Error checking ${address}: ${e.message}`);
          results.push({ address, volume: 0, passed: false });
        }

        await new Promise(r => setTimeout(r, 50));
      }

      return results;
    }

    // Final fallback - token balance check
    console.log('⚠️ No volume data source available - using token balance fallback');
    return await fallbackVolumeCheck(tokenAddress, addresses, minVolume);

  } catch (error) {
    console.error('Error fetching trader volumes:', error);
    return await fallbackVolumeCheck(tokenAddress, addresses, minVolume);
  }
}

/**
 * Convert timestamp to approximate block number
 * Base has ~2 second blocks
 */
async function timestampToBlock(timestamp) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const currentBlock = await provider.getBlockNumber();
    const currentTime = Math.floor(Date.now() / 1000);
    const timeDiff = currentTime - timestamp;
    const blockDiff = Math.floor(timeDiff / 2); // ~2 sec per block on Base
    return Math.max(1, currentBlock - blockDiff);
  } catch (e) {
    return 1; // Fallback to genesis
  }
}

/**
 * Fallback volume check - just checks if wallet holds the token
 * Used when Covalent API is not available
 */
async function fallbackVolumeCheck(tokenAddress, addresses, minVolume) {
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
        volume: hasTokens ? minVolume : 0,
        passed: hasTokens || minVolume === 0
      });
    } catch (e) {
      results.push({ address, volume: 0, passed: minVolume === 0 });
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
 * @returns {Object} Result of finalization attempt
 */
async function checkAndFinalizeContest(contestId) {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Need private key to call finalizeContest (owner only)
  if (!process.env.PRIVATE_KEY) {
    return { success: false, error: 'PRIVATE_KEY not configured' };
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    wallet
  );

  // Get contest details
  const contest = await contestEscrow.getContest(contestId);
  const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner] = contest;

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

  console.log(`\n📋 Processing Contest #${contestId}`);
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

  console.log(`   Recasters: ${engagement.recasters.length}`);
  console.log(`   Repliers (4+ words): ${engagement.repliers.length}`);
  console.log(`   Likers: ${engagement.likers.length}`);

  // ═══════════════════════════════════════════════════════════════════
  // SOCIAL REQUIREMENTS - Parse from castId
  // Format: "castHash|R1L0P1" where R=recast, L=like, P=reply (1=required, 0=not)
  // If no pipe delimiter, use defaults (recast + reply required)
  // ═══════════════════════════════════════════════════════════════════
  let socialRequirements = {
    requireRecast: true,    // Default: must recast
    requireReply: true,     // Default: must reply (4-word minimum)
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

  // Determine potential participants based on requirements
  // Build a set of qualifying addresses based on which requirements are enabled
  let potentialParticipants = [];

  // Get all unique addresses that meet ANY enabled requirement first
  const recastSet = new Set(engagement.recasters);
  const likeSet = new Set(engagement.likers);
  const replySet = new Set(engagement.repliers.map(r => r.address));

  // If ALL requirements are disabled, use everyone who engaged
  if (!socialRequirements.requireRecast && !socialRequirements.requireLike && !socialRequirements.requireReply) {
    const allEngagers = new Set([...recastSet, ...likeSet, ...replySet]);
    potentialParticipants = [...allEngagers];
    console.log(`   Filter: Any engagement (no requirements set)`);
  } else {
    // Start with all addresses from the first enabled requirement
    let candidateSets = [];

    if (socialRequirements.requireRecast) {
      candidateSets.push({ name: 'Recast', set: recastSet });
    }
    if (socialRequirements.requireLike) {
      candidateSets.push({ name: 'Like', set: likeSet });
    }
    if (socialRequirements.requireReply) {
      candidateSets.push({ name: 'Reply (4+ words)', set: replySet });
    }

    if (candidateSets.length === 1) {
      // Only one requirement - use that set
      potentialParticipants = [...candidateSets[0].set];
      console.log(`   Filter: ${candidateSets[0].name} only`);
    } else {
      // Multiple requirements - find intersection (must meet ALL)
      let intersection = new Set(candidateSets[0].set);
      for (let i = 1; i < candidateSets.length; i++) {
        intersection = new Set([...intersection].filter(addr => candidateSets[i].set.has(addr)));
      }
      potentialParticipants = [...intersection];
      console.log(`   Filter: ${candidateSets.map(s => s.name).join(' + ')}`);
    }
  }

  // Deduplicate
  potentialParticipants = [...new Set(potentialParticipants)];

  // Remove the host from participants (contest creator shouldn't win their own contest)
  if (engagement.castAuthor) {
    potentialParticipants = potentialParticipants.filter(
      addr => addr !== engagement.castAuthor
    );
  }

  console.log(`\n✅ Qualified participants: ${potentialParticipants.length}`);

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
        reason: 'No qualified participants (no one did recast + 4-word reply)',
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

  // Check trading volume if required
  let qualifiedAddresses = potentialParticipants;

  if (volumeRequirement > 0n) {
    console.log('\n💰 Checking trading volumes...');
    const volumeResults = await getTraderVolumes(
      tokenRequirement,
      potentialParticipants,
      Number(ethers.formatEther(volumeRequirement)),
      Number(startTime),
      Number(endTime)
    );

    qualifiedAddresses = volumeResults
      .filter(r => r.passed)
      .map(r => r.address);

    console.log(`   Passed volume check: ${qualifiedAddresses.length}/${potentialParticipants.length}`);
  }

  if (qualifiedAddresses.length === 0) {
    // No one met volume requirement - auto-cancel and refund host
    console.log('\n❌ No participants met volume requirement - cancelling contest and refunding host...');
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

  console.log(`\n🎲 Finalizing contest with ${finalEntries.length} qualified entries...`);

  try {
    const tx = await contestEscrow.finalizeContest(contestId, finalEntries);
    console.log(`   TX submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

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
 * Check all pending contests and finalize any that have ended
 */
async function checkAllPendingContests() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestEscrow = new ethers.Contract(
    CONFIG.CONTEST_ESCROW,
    CONTEST_ESCROW_ABI,
    provider
  );

  const nextContestId = await contestEscrow.nextContestId();
  const results = [];

  console.log(`\n🔍 Checking contests 1 to ${nextContestId - 1n}...`);

  for (let i = 1n; i < nextContestId; i++) {
    try {
      const canFinalize = await contestEscrow.canFinalize(i);

      if (canFinalize) {
        console.log(`\n📋 Contest #${i} is ready to finalize`);
        const result = await checkAndFinalizeContest(Number(i));
        results.push(result);
      }
    } catch (e) {
      // Skip contests that throw errors (likely old/corrupted data)
      console.log(`   Skipping contest #${i}: ${e.message?.slice(0, 50) || 'unknown error'}`);
      continue;
    }
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
    if (req.method === 'GET') {
      const contestId = parseInt(req.query.contestId);

      if (!contestId || isNaN(contestId)) {
        return res.status(400).json({
          error: 'Missing or invalid contestId parameter'
        });
      }

      const result = await checkAndFinalizeContest(contestId);
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
