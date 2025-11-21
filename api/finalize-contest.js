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

    // Get reactions (likes and recasts)
    const reactionsResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castId}&types=likes,recasts&limit=100`,
      {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      }
    );

    let likers = [];
    let recasters = [];

    if (reactionsResponse.ok) {
      const reactionsData = await reactionsResponse.json();

      // Extract unique addresses from reactions
      for (const reaction of reactionsData.reactions || []) {
        const addresses = reaction.user?.verified_addresses?.eth_addresses || [];
        if (reaction.reaction_type === 'like') {
          likers.push(...addresses);
        } else if (reaction.reaction_type === 'recast') {
          recasters.push(...addresses);
        }
      }
    }

    // Get replies
    const repliesResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castId}&type=hash&reply_depth=1&limit=100`,
      {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      }
    );

    let repliers = [];

    if (repliesResponse.ok) {
      const repliesData = await repliesResponse.json();
      const replies = repliesData.conversation?.cast?.direct_replies || [];

      for (const reply of replies) {
        // Check reply has at least 4 words
        const wordCount = (reply.text || '').trim().split(/\s+/).length;
        if (wordCount >= 4) {
          const addresses = reply.author?.verified_addresses?.eth_addresses || [];
          repliers.push(...addresses.map(addr => ({
            address: addr.toLowerCase(),
            wordCount
          })));
        }
      }
    }

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
// COVALENT API - Get Trading Volume (FREE TIER: 300K credits/month)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get trading volume for addresses on a specific token
 * Uses Covalent's GoldRush API (free tier available)
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

    const COVALENT_API_KEY = process.env.COVALENT_API_KEY;

    if (!COVALENT_API_KEY) {
      console.log('⚠️ COVALENT_API_KEY not set - using fallback (token balance check)');
      return await fallbackVolumeCheck(tokenAddress, addresses, minVolume);
    }

    // Base chain ID for Covalent
    const CHAIN_ID = 'base-mainnet';

    const results = [];

    for (const address of addresses) {
      try {
        // Get ERC20 token transfers for this wallet
        // This endpoint returns all token transfers to/from the wallet
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

        // Calculate total volume (sum of all transfers in/out)
        let totalVolume = 0n;

        for (const transfer of transfers) {
          for (const item of transfer.transfers || []) {
            if (item.contract_address?.toLowerCase() === tokenAddress.toLowerCase()) {
              // Add the delta (absolute value of transfer)
              const delta = BigInt(item.delta || '0');
              totalVolume += delta > 0n ? delta : -delta;
            }
          }
        }

        // Convert to token units (assuming 18 decimals, adjust if needed)
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

      // Rate limiting - Covalent allows 50 req/sec, but let's be safe
      await new Promise(r => setTimeout(r, 50));
    }

    return results;

  } catch (error) {
    console.error('Error fetching trader volumes:', error);
    // On error, use fallback
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
  console.log(`   Cast ID: ${castId}`);
  console.log(`   Token Requirement: ${tokenRequirement}`);
  console.log(`   Volume Requirement: ${ethers.formatEther(volumeRequirement)} tokens`);

  // Get social engagement
  console.log('\n🔍 Fetching social engagement from Neynar...');
  const engagement = await getCastEngagement(castId);

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

  // Determine potential participants
  // Must have: recasted AND replied with 4+ words
  const recasterSet = new Set(engagement.recasters);
  const replierAddresses = engagement.repliers.map(r => r.address);

  // Find addresses that both recasted AND replied
  let potentialParticipants = replierAddresses.filter(addr => recasterSet.has(addr));

  // Remove the host from participants
  if (engagement.castAuthor) {
    potentialParticipants = potentialParticipants.filter(
      addr => addr !== engagement.castAuthor
    );
  }

  console.log(`\n✅ Potential participants (recasted + replied): ${potentialParticipants.length}`);

  if (potentialParticipants.length === 0) {
    // No qualified participants - might need to cancel
    return {
      success: false,
      error: 'No qualified participants found',
      contestId,
      suggestion: 'Consider cancelling the contest and refunding the host'
    };
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
    return {
      success: false,
      error: 'No participants met volume requirement',
      contestId,
      suggestion: 'Consider cancelling the contest and refunding the host'
    };
  }

  // Finalize contest on-chain
  console.log(`\n🎲 Finalizing contest with ${qualifiedAddresses.length} qualified entries...`);

  try {
    const tx = await contestEscrow.finalizeContest(contestId, qualifiedAddresses);
    console.log(`   TX submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    return {
      success: true,
      contestId,
      qualifiedCount: qualifiedAddresses.length,
      txHash: receipt.hash,
      message: 'Contest finalized! Chainlink VRF will select winner shortly.'
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
    const canFinalize = await contestEscrow.canFinalize(i);

    if (canFinalize) {
      console.log(`\n📋 Contest #${i} is ready to finalize`);
      const result = await checkAndFinalizeContest(Number(i));
      results.push(result);
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
