/**
 * Contest Finalization API - Unified ContestManager
 *
 * This endpoint checks if a contest has ended and finalizes it by:
 * 1. Getting entries from KV storage (users who clicked Enter)
 * 2. Checking for bonus entries:
 *    - 100M+ NEYNARTODES holder = +1 bonus entry
 *    - 3+ word reply on contest cast = +1 bonus entry
 *    - Clicked Share button = +1 bonus entry
 * 3. Calling finalizeContest() on the unified ContestManager
 *
 * NO LONGER REQUIRES: likes, recasts
 *
 * Usage:
 *   GET /api/finalize-contest?contestId=M-1    (Main contest)
 *   GET /api/finalize-contest?contestId=T-1    (Test contest)
 *   POST /api/finalize-contest                  (Cron - checks last 50 contests)
 */

const { ethers } = require('ethers');
const { parseContestId } = require('./lib/config');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',

  // Token
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',

  // RPC
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',

  // API Keys
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',

  // How many contests to check in cron
  MAX_CONTESTS_TO_CHECK: 50,

  // Holder threshold for bonus entry (100M tokens)
  HOLDER_THRESHOLD: 100000000n * 10n ** 18n,

  // Minimum words for reply bonus
  MIN_REPLY_WORDS: 3,

  // Blocked FIDs - these users cannot win contests
  BLOCKED_FIDS: [
    1188162,  // App owner - excluded from winning
    1990047,  // ropiik - scam token contests
    892902,   // liadavid - suspected multi-account abuse
    533329,   // ayeshawaqas - suspected multi-account abuse
    940217,   // futurepicker - suspected multi-account abuse
    874752,   // lunamarsh - suspected multi-account abuse
  ],
};

// Unified ContestManager ABI
const CONTEST_MANAGER_ABI = [
  // View functions
  'function getContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
  'function getTestContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
  'function canFinalize(uint256 contestId) view returns (bool)',
  'function canFinalizeTest(uint256 contestId) view returns (bool)',
  // Finalization
  'function finalizeContest(uint256 contestId, address[] calldata qualifiedAddresses) external',
  'function finalizeTestContest(uint256 contestId, address[] calldata qualifiedAddresses) external',
  // Cancel
  'function cancelContest(uint256 contestId, string calldata reason) external',
  'function cancelTestContest(uint256 contestId, string calldata reason) external',
];

// ═══════════════════════════════════════════════════════════════════
// HOLDER CHECK - 100M NEYNARTODES = bonus entry
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if user holds 100M+ NEYNARTODES across all addresses
 * @param {string[]} addresses - User's wallet addresses
 * @param {object} provider - Ethers provider
 * @returns {Promise<{isHolder: boolean, balance: bigint}>}
 */
async function checkHolderStatus(addresses, provider) {
  const neynartodes = new ethers.Contract(
    CONFIG.NEYNARTODES_TOKEN,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  // Fetch all balances in parallel
  const balancePromises = addresses.map(addr =>
    neynartodes.balanceOf(addr).catch(() => 0n)
  );

  const balances = await Promise.all(balancePromises);
  const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);

  return {
    isHolder: totalBalance >= CONFIG.HOLDER_THRESHOLD,
    balance: totalBalance
  };
}

// ═══════════════════════════════════════════════════════════════════
// REPLY CHECK - 3+ word reply = bonus entry
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all users who replied to a cast with 3+ words
 * @param {string} castHash - The contest cast hash
 * @returns {Promise<Map<number, {fid: number, wordCount: number}>>} Map of FID -> reply data
 */
async function getRepliers(castHash) {
  const repliersByFid = new Map();

  try {
    let cursor = null;
    let pageCount = 0;
    const maxPages = 20;

    do {
      const url = cursor
        ? `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castHash}&type=hash&reply_depth=1&limit=50&cursor=${cursor}`
        : `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castHash}&type=hash&reply_depth=1&limit=50`;

      const response = await fetch(url, {
        headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
      });

      if (!response.ok) break;

      const data = await response.json();
      const replies = data.conversation?.cast?.direct_replies || [];

      for (const reply of replies) {
        const fid = reply.author?.fid;
        if (!fid) continue;

        const wordCount = (reply.text || '').trim().split(/\s+/).filter(w => w.length > 0).length;

        // Only count replies with 3+ words
        if (wordCount >= CONFIG.MIN_REPLY_WORDS) {
          const existing = repliersByFid.get(fid);
          if (!existing || wordCount > existing.wordCount) {
            repliersByFid.set(fid, { fid, wordCount });
          }
        }
      }

      cursor = data.next?.cursor;
      pageCount++;
      if (cursor) await new Promise(r => setTimeout(r, 100));

    } while (cursor && pageCount < maxPages);

    console.log(`   Found ${repliersByFid.size} users with ${CONFIG.MIN_REPLY_WORDS}+ word replies`);

  } catch (error) {
    console.error('Error fetching replies:', error.message);
  }

  return repliersByFid;
}

// ═══════════════════════════════════════════════════════════════════
// SHARE CHECK - User clicked Share button = bonus entry
// ═══════════════════════════════════════════════════════════════════

/**
 * Get users who shared the contest (clicked Share button)
 * @param {string} contestId - Contest ID (M-1 or T-1 format)
 * @returns {Promise<Set<number>>} Set of FIDs who shared
 */
async function getSharers(contestId) {
  const sharers = new Set();

  try {
    if (!process.env.KV_REST_API_URL) return sharers;

    const { kv } = require('@vercel/kv');
    const shareKey = `contest_shares:${contestId}`;
    const shareFids = await kv.smembers(shareKey);

    if (Array.isArray(shareFids)) {
      shareFids.forEach(fid => sharers.add(parseInt(fid)));
    }

    console.log(`   Found ${sharers.size} users who clicked Share`);

  } catch (error) {
    console.error('Error fetching sharers:', error.message);
  }

  return sharers;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN FINALIZATION LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Finalize a unified ContestManager contest (M- or T- prefix)
 * @param {string} contestIdStr - Contest ID like "M-1" or "T-1"
 * @returns {Promise<object>} Result of finalization
 */
async function finalizeUnifiedContest(contestIdStr) {
  const parsed = parseContestId(contestIdStr);
  if (!parsed || (parsed.type !== 'main' && parsed.type !== 'test')) {
    return { success: false, error: 'Invalid contest ID format. Use M-X or T-X' };
  }

  const isTest = parsed.type === 'test';
  const numericId = parsed.id;

  console.log(`\n📋 Processing ${isTest ? 'Test' : 'Main'} Contest ${contestIdStr}`);

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Need private key to call finalizeContest
  if (!process.env.PRIVATE_KEY) {
    return { success: false, error: 'PRIVATE_KEY not configured' };
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, wallet);

  // Get contest details
  const getContestFn = isTest ? 'getTestContest' : 'getContest';
  const contest = await contestManager[getContestFn](numericId);

  const {
    host,
    prizeType,
    endTime,
    castId,
    status,
    winnerCount
  } = contest;

  // Status: 0=Active, 1=PendingVRF, 2=Completed, 3=Cancelled
  if (status !== 0n) {
    return { success: false, error: `Contest not active (status: ${status})`, contestId: contestIdStr };
  }

  // Check if contest has ended
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(endTime)) {
    return {
      success: false,
      error: `Contest not ended yet (ends: ${new Date(Number(endTime) * 1000).toISOString()})`,
      contestId: contestIdStr
    };
  }

  console.log(`   Host: ${host}`);
  console.log(`   Prize Type: ${prizeType} (0=ETH, 1=ERC20, 2=ERC721, 3=ERC1155)`);
  console.log(`   Winner Count: ${winnerCount}`);

  // Extract cast hash from castId (format: "0xhash" or "0xhash|R1L0P1")
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
  console.log(`   Cast Hash: ${actualCastHash}`);

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: Get entries from KV (users who clicked Enter button)
  // ═══════════════════════════════════════════════════════════════════
  let enteredFids = new Set();

  try {
    if (!process.env.KV_REST_API_URL) {
      return { success: false, error: 'KV storage not configured' };
    }

    const { kv } = require('@vercel/kv');
    const entryKey = `contest_entries:${contestIdStr}`;
    const fids = await kv.smembers(entryKey);

    if (Array.isArray(fids)) {
      enteredFids = new Set(fids.map(f => parseInt(f)));
    }

    console.log(`\n👥 Users who clicked Enter: ${enteredFids.size}`);

  } catch (e) {
    console.error('Error fetching entries:', e.message);
    return { success: false, error: `Failed to fetch entries: ${e.message}` };
  }

  // No entries = cancel contest
  if (enteredFids.size === 0) {
    console.log('\n❌ No entries - cancelling contest...');
    try {
      const cancelFn = isTest ? 'cancelTestContest' : 'cancelContest';
      const tx = await contestManager[cancelFn](numericId, 'No entries');
      console.log(`   TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`   ✅ Cancelled in block ${receipt.blockNumber}`);
      return {
        success: true,
        contestId: contestIdStr,
        action: 'cancelled',
        reason: 'No entries',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      return { success: false, error: `Cancel failed: ${cancelError.message}` };
    }
  }

  // Filter out blocked FIDs and host
  const hostFid = await getHostFid(actualCastHash);
  const eligibleFids = [...enteredFids].filter(fid => {
    if (CONFIG.BLOCKED_FIDS.includes(fid)) {
      console.log(`   Skipping blocked FID: ${fid}`);
      return false;
    }
    if (fid === hostFid) {
      console.log(`   Skipping host FID: ${fid}`);
      return false;
    }
    return true;
  });

  console.log(`   Eligible FIDs: ${eligibleFids.length}`);

  if (eligibleFids.length === 0) {
    console.log('\n❌ No eligible entries - cancelling contest...');
    try {
      const cancelFn = isTest ? 'cancelTestContest' : 'cancelContest';
      const tx = await contestManager[cancelFn](numericId, 'No eligible participants');
      const receipt = await tx.wait();
      return {
        success: true,
        contestId: contestIdStr,
        action: 'cancelled',
        reason: 'No eligible participants',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      return { success: false, error: `Cancel failed: ${cancelError.message}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: Fetch user data from Neynar
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n📡 Fetching user data from Neynar...');
  const users = new Map(); // FID -> { fid, username, addresses, primaryAddress }

  const BATCH_SIZE = 100;
  for (let i = 0; i < eligibleFids.length; i += BATCH_SIZE) {
    const batch = eligibleFids.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch(
        `https://api.neynar.com/v2/farcaster/user/bulk?fids=${batch.join(',')}`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (response.ok) {
        const data = await response.json();
        for (const user of (data.users || [])) {
          const addresses = [];
          if (user.custody_address) {
            addresses.push(user.custody_address.toLowerCase());
          }
          if (user.verified_addresses?.eth_addresses) {
            addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
          }

          if (addresses.length > 0) {
            // Determine primary address for prize delivery
            let primaryAddress = null;
            if (user.verified_addresses?.primary?.eth_address) {
              primaryAddress = user.verified_addresses.primary.eth_address.toLowerCase();
            } else if (user.verified_addresses?.eth_addresses?.length > 0) {
              primaryAddress = user.verified_addresses.eth_addresses[0].toLowerCase();
            } else if (user.custody_address) {
              primaryAddress = user.custody_address.toLowerCase();
            }

            users.set(user.fid, {
              fid: user.fid,
              username: user.username || '',
              addresses: [...new Set(addresses)],
              primaryAddress: primaryAddress || addresses[0]
            });
          }
        }
      }
    } catch (e) {
      console.log(`   Error fetching batch: ${e.message}`);
    }
  }

  console.log(`   Fetched data for ${users.size} users`);

  if (users.size === 0) {
    console.log('\n❌ No valid users - cancelling contest...');
    try {
      const cancelFn = isTest ? 'cancelTestContest' : 'cancelContest';
      const tx = await contestManager[cancelFn](numericId, 'No valid participants');
      const receipt = await tx.wait();
      return {
        success: true,
        contestId: contestIdStr,
        action: 'cancelled',
        reason: 'No valid participants',
        txHash: receipt.hash
      };
    } catch (cancelError) {
      return { success: false, error: `Cancel failed: ${cancelError.message}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: Check bonus qualifications in parallel
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n🎁 Checking bonus qualifications...');

  // Fetch repliers and sharers in parallel
  const [repliersByFid, sharers] = await Promise.all([
    getRepliers(actualCastHash),
    getSharers(contestIdStr)
  ]);

  // Check holder status for all users (in batches)
  const holderStatus = new Map(); // FID -> boolean
  const userArray = [...users.values()];
  const HOLDER_BATCH_SIZE = 10;

  console.log('\n💎 Checking 100M holder status...');
  for (let i = 0; i < userArray.length; i += HOLDER_BATCH_SIZE) {
    const batch = userArray.slice(i, i + HOLDER_BATCH_SIZE);
    const holderChecks = await Promise.all(
      batch.map(user => checkHolderStatus(user.addresses, provider))
    );

    batch.forEach((user, idx) => {
      const result = holderChecks[idx];
      holderStatus.set(user.fid, result.isHolder);
      if (result.isHolder) {
        console.log(`   💎 @${user.username} is a HOLDER (${ethers.formatEther(result.balance)} tokens)`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 4: Build final entries with bonuses
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n📝 Building entry list with bonuses...');

  const qualifiedAddresses = [];
  let holderBonusCount = 0;
  let replyBonusCount = 0;
  let shareBonusCount = 0;

  for (const user of users.values()) {
    // Base entry (everyone who clicked Enter gets 1 entry)
    qualifiedAddresses.push(user.primaryAddress);

    // Bonus 1: 100M+ NEYNARTODES holder
    if (holderStatus.get(user.fid)) {
      qualifiedAddresses.push(user.primaryAddress);
      holderBonusCount++;
      console.log(`   💎 Holder bonus: @${user.username}`);
    }

    // Bonus 2: 3+ word reply
    const replyData = repliersByFid.get(user.fid);
    if (replyData && replyData.wordCount >= CONFIG.MIN_REPLY_WORDS) {
      qualifiedAddresses.push(user.primaryAddress);
      replyBonusCount++;
      console.log(`   💬 Reply bonus: @${user.username} (${replyData.wordCount} words)`);
    }

    // Bonus 3: Clicked Share button
    if (sharers.has(user.fid)) {
      qualifiedAddresses.push(user.primaryAddress);
      shareBonusCount++;
      console.log(`   📤 Share bonus: @${user.username}`);
    }
  }

  console.log(`\n📊 Entry Summary:`);
  console.log(`   Base entries: ${users.size}`);
  console.log(`   Holder bonuses: ${holderBonusCount}`);
  console.log(`   Reply bonuses: ${replyBonusCount}`);
  console.log(`   Share bonuses: ${shareBonusCount}`);
  console.log(`   Total entries: ${qualifiedAddresses.length}`);

  // ═══════════════════════════════════════════════════════════════════
  // STEP 5: Finalize contest on-chain
  // ═══════════════════════════════════════════════════════════════════

  // Limit entries to avoid gas issues
  const MAX_ENTRIES = 1000;
  let finalEntries = qualifiedAddresses;

  if (qualifiedAddresses.length > MAX_ENTRIES) {
    console.log(`\n⚠️ Too many entries (${qualifiedAddresses.length}), randomly sampling ${MAX_ENTRIES}...`);
    const shuffled = [...qualifiedAddresses].sort(() => Math.random() - 0.5);
    finalEntries = shuffled.slice(0, MAX_ENTRIES);
  }

  console.log(`\n🎲 Finalizing contest with ${finalEntries.length} entries (${winnerCount} winners)...`);

  try {
    const finalizeFn = isTest ? 'finalizeTestContest' : 'finalizeContest';
    const tx = await contestManager[finalizeFn](numericId, finalEntries);
    console.log(`   TX: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    // Store TX hash in KV
    try {
      const { kv } = require('@vercel/kv');
      await kv.set(`finalize_tx:${contestIdStr}`, tx.hash);
    } catch (e) {}

    // Poll for winners
    console.log('\n⏳ Waiting for winner selection...');
    let selectedWinners = [];
    let attempts = 0;
    const maxAttempts = 30;

    while (selectedWinners.length === 0 && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;

      try {
        const updatedContest = await contestManager[getContestFn](numericId);
        if (updatedContest.status === 2n && updatedContest.winners.length > 0) {
          selectedWinners = updatedContest.winners;
          console.log(`   ✅ ${selectedWinners.length} winner(s) selected!`);
          for (const w of selectedWinners) {
            console.log(`      - ${w}`);
          }
          break;
        }
        console.log(`   Attempt ${attempts}/${maxAttempts}...`);
      } catch (e) {}
    }

    // Auto-announce if winners selected
    if (selectedWinners.length > 0) {
      console.log('\n📢 Auto-announcing winners...');
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000';

        const announceResponse = await fetch(`${baseUrl}/api/announce-winner?contestId=${contestIdStr}`);
        const announceResult = await announceResponse.json();

        if (announceResult.posted) {
          console.log(`   ✅ Announcement posted! Cast: ${announceResult.castHash}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Auto-announce failed: ${e.message}`);
      }
    }

    return {
      success: true,
      contestId: contestIdStr,
      isTest,
      qualifiedCount: users.size,
      totalEntries: finalEntries.length,
      bonuses: {
        holder: holderBonusCount,
        reply: replyBonusCount,
        share: shareBonusCount
      },
      txHash: receipt.hash,
      winners: selectedWinners.length > 0 ? selectedWinners : null,
      message: selectedWinners.length > 0
        ? 'Contest finalized! Winners selected.'
        : 'Contest finalized! Winners will be selected shortly.'
    };

  } catch (error) {
    console.error('   ❌ Finalization failed:', error.message);
    return { success: false, error: error.message, contestId: contestIdStr };
  }
}

/**
 * Get host FID from cast hash
 */
async function getHostFid(castHash) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${castHash}&type=hash`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (response.ok) {
      const data = await response.json();
      return data.cast?.author?.fid || null;
    }
  } catch (e) {}
  return null;
}

/**
 * Check all pending contests (last 50 for main and test)
 */
async function checkAllPendingContests() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);
  const results = [];

  console.log('\n🔍 Checking last 50 contests...');

  // Check main contests
  try {
    const mainNextId = await contestManager.mainNextContestId();
    const mainStartId = mainNextId > BigInt(CONFIG.MAX_CONTESTS_TO_CHECK)
      ? mainNextId - BigInt(CONFIG.MAX_CONTESTS_TO_CHECK)
      : 1n;

    console.log(`\n📋 Checking Main contests ${mainStartId} to ${mainNextId - 1n}...`);

    for (let i = mainStartId; i < mainNextId; i++) {
      try {
        const canFinalize = await contestManager.canFinalize(i);
        if (canFinalize) {
          console.log(`\n✅ M-${i} is ready to finalize`);
          const result = await finalizeUnifiedContest(`M-${i}`);
          results.push(result);
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.log(`⚠️ Could not check main contests: ${e.message}`);
  }

  // Check test contests
  try {
    const testNextId = await contestManager.testNextContestId();
    const testStartId = testNextId > BigInt(CONFIG.MAX_CONTESTS_TO_CHECK)
      ? testNextId - BigInt(CONFIG.MAX_CONTESTS_TO_CHECK)
      : 1n;

    console.log(`\n📋 Checking Test contests ${testStartId} to ${testNextId - 1n}...`);

    for (let i = testStartId; i < testNextId; i++) {
      try {
        const canFinalize = await contestManager.canFinalizeTest(i);
        if (canFinalize) {
          console.log(`\n✅ T-${i} is ready to finalize`);
          const result = await finalizeUnifiedContest(`T-${i}`);
          results.push(result);
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.log(`⚠️ Could not check test contests: ${e.message}`);
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
      const contestIdStr = req.query.contestId;
      const parsed = parseContestId(contestIdStr);

      // No contestId = cron request
      if (!parsed) {
        const authHeader = req.headers['authorization'];
        const cronSecret = process.env.CRON_SECRET;

        if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
          return res.status(400).json({
            error: 'Missing or invalid contestId',
            hint: 'Use ?contestId=M-1 for main contests, ?contestId=T-1 for test contests'
          });
        }

        console.log('🕐 Cron triggered - checking all pending contests...');
        const results = await checkAllPendingContests();
        return res.status(200).json({ cron: true, checked: results.length, results });
      }

      // Must be M- or T- prefix
      if (parsed.type !== 'main' && parsed.type !== 'test') {
        return res.status(400).json({
          error: 'Invalid contest ID format',
          hint: 'Use M-X for main contests or T-X for test contests',
          received: contestIdStr
        });
      }

      const result = await finalizeUnifiedContest(contestIdStr);
      return res.status(result.success ? 200 : 400).json(result);
    }

    // POST: Check all pending contests (for cron)
    if (req.method === 'POST') {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const results = await checkAllPendingContests();
      return res.status(200).json({ checked: results.length, results });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// For local testing
if (require.main === module) {
  const contestId = process.argv[2];

  if (contestId) {
    finalizeUnifiedContest(contestId)
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
