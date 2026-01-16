/**
 * Contest Participants API
 *
 * Returns participant profile pictures for a contest.
 * Used to display floating PFPs in the active contests section.
 *
 * GET /api/contest-participants?contestId=112
 * Returns: { participants: [{ fid, pfpUrl, username, hasReplied, isHolder, hasShared, entryCount }] }
 *
 * Entry counts:
 * - Base entry: 1 (everyone who enters)
 * - Holder bonus: +1 (100M+ NEYNARTODES)
 * - Reply bonus: +1 (replied with 3+ words)
 * - Share bonus: +1 (clicked Share button)
 * - Volume bonus: +1 (checked at finalization only)
 * - Max visible entries: 4 (volume checked only at finalization)
 */

const { ethers } = require('ethers');
const { getUsersByFids, getCastConversation } = require('./lib/utils');

// NEYNARTODES token for holder check
const NEYNARTODES_TOKEN = '0x8dE1622fE07f56cda2e2273e615A513F1d828B07';
const HOLDER_THRESHOLD = ethers.parseUnits('100000000', 18); // 100M tokens
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// Transfer cooldown to prevent gaming (36 hours)
const TRANSFER_COOLDOWN_HOURS = 36;

// DEX addresses - transfers FROM these are purchases (no cooldown)
const DEX_ADDRESSES = new Set([
  '0x5d7f0d6c17a245b62e6a08280f580c59631e8136', // Uniswap V3 NEYNARTODES/WETH pool
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 SwapRouter02
  '0x0000000000000000000000000000000000000000', // Zero address (minting)
  '0x75a2c417b9e2f00d47ad94f8c0894066e31e38d9', // Clanker deployer
]);

// Unified ContestManager ABI
// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
];

// Unified ContestManager address
const CONTEST_MANAGER_ADDRESS = '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache for 2 minutes
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contestId, refresh } = req.query;

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId parameter' });
  }

  // Allow force refresh with ?refresh=1 to recalculate holder status
  const forceRefresh = refresh === '1' || refresh === 'true';

  // Log immediately when request arrives (helps debug if cache is hiding issues)
  console.log(`[contest-participants] Contest ${contestId} - Request received, refresh=${forceRefresh}`);

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ participants: [], error: 'KV not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Check for cached participant data first (includes entry counts for consistent colors)
    const cacheKey = `contest:participants:${contestId}`;

    if (!forceRefresh) {
      const cached = await kv.get(cacheKey);
      if (cached && cached.participants && cached.cachedAt) {
        // Cache valid for 5 minutes
        const cacheAge = Date.now() - cached.cachedAt;
        if (cacheAge < 300000) {
          console.log(`Contest ${contestId}: Using cached participants (${cached.participants.length} users, age: ${Math.round(cacheAge/1000)}s)`);
          return res.status(200).json({
            participants: cached.participants,
            count: cached.count,
            displayed: cached.participants.length,
            fromCache: true
          });
        }
      }
    } else {
      console.log(`Contest ${contestId}: Force refresh requested, recalculating...`);
    }

    // Get all FIDs who entered this contest
    // Contest ID format: M-1, T-1, etc.
    let entryFids = await kv.smembers(`contest_entries:${contestId}`);
    entryFids = Array.isArray(entryFids) ? entryFids : [];

    if (!entryFids || entryFids.length === 0) {
      return res.status(200).json({ participants: [], count: 0 });
    }

    // Limit to 30 participants (for display purposes)
    const limitedFids = entryFids.slice(0, 30);

    // Fetch user profiles from Neynar in bulk (cached)
    const users = await getUsersByFids(limitedFids.map(f => parseInt(f)));

    console.log(`Contest ${contestId}: Fetched ${users?.length || 0} users from Neynar`);

    if (!users || users.length === 0) {
      return res.status(200).json({ participants: [], count: entryFids.length });
    }

    // Debug: Log first user's addresses to verify we're getting them
    if (users[0]) {
      console.log(`Contest ${contestId}: First user ${users[0].fid} (${users[0].username}) addresses:`, {
        verified: users[0].verified_addresses?.eth_addresses || [],
        custody: users[0].custody_address || 'none'
      });
    }

    // Now fetch actual replies from the contest cast to determine who has replied
    const hasRepliedSet = new Set();

    // Initialize provider for RPC calls (used for both replies and holder checks)
    const RPC_URL = process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/';
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    try {
      // Get the cast hash from the unified ContestManager
      // Contest ID format: M-1, T-1, etc.
      const isTestContest = contestId.startsWith('T-');
      const numericId = parseInt(contestId.replace(/^[MT]-/, ''));

      const contract = new ethers.Contract(CONTEST_MANAGER_ADDRESS, CONTEST_MANAGER_ABI, provider);
      const contestData = isTestContest
        ? await contract.getTestContestFull(numericId)
        : await contract.getContestFull(numericId);

      // Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
      const castId = contestData.castId;

      // Extract actual cast hash (remove requirements suffix if present)
      const actualCastHash = castId && castId.includes('|') ? castId.split('|')[0] : castId;

      if (actualCastHash && actualCastHash.length > 0) {
        // Fetch replies from Neynar (cached)
        const conversation = await getCastConversation(actualCastHash);

        // Copy replier FIDs to our set
        for (const fid of conversation.replierFids) {
          hasRepliedSet.add(fid);
        }
        console.log(`Contest ${contestId}: Found ${conversation.replies.length} replies, hasRepliedSet size: ${hasRepliedSet.size}`);
      }
    } catch (replyError) {
      console.error('Error fetching replies:', replyError.message);
      // Continue without reply data - just won't show stacked PFPs
    }

    // Check holder status for all users - do in small batches to avoid RPC rate limits
    const holderStatusMap = new Map();
    const token = new ethers.Contract(NEYNARTODES_TOKEN, ERC20_ABI, provider);
    const transferEventAbi = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
    const tokenWithEvents = new ethers.Contract(NEYNARTODES_TOKEN, transferEventAbi, provider);

    // Calculate block range for cooldown period (~2 sec blocks on Base)
    const blocksPerHour = 1800;
    const cooldownBlocks = TRANSFER_COOLDOWN_HOURS * blocksPerHour;
    const currentBlock = await provider.getBlockNumber();
    const cooldownFromBlock = Math.max(0, currentBlock - cooldownBlocks);

    // Helper to format token balance
    function formatTokenBalance(balance) {
      const num = Number(balance / (10n ** 18n));
      if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
      if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
      if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
      return num.toFixed(0);
    }

    // Helper to calculate cooldown amount (tokens received via wallet-to-wallet transfer)
    async function calculateCooldownAmount(addresses) {
      try {
        const normalizedAddresses = addresses.map(a => a.toLowerCase());
        let cooldownAmount = 0n;

        for (const addr of addresses) {
          const filter = tokenWithEvents.filters.Transfer(null, addr);
          const events = await tokenWithEvents.queryFilter(filter, cooldownFromBlock, currentBlock);

          for (const event of events) {
            const fromAddr = event.args.from.toLowerCase();

            // Skip if transfer is from a DEX (this is a purchase, not a transfer)
            if (DEX_ADDRESSES.has(fromAddr)) continue;

            // Skip if transfer is between user's own addresses
            if (normalizedAddresses.includes(fromAddr)) continue;

            cooldownAmount += BigInt(event.args.value);
          }
        }
        return cooldownAmount;
      } catch (e) {
        return 0n; // On error, don't penalize
      }
    }

    // Process holder checks in batches of 5 to avoid rate limiting
    const holderChecks = [];
    const batchSize = 5;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (user) => {
          try {
            // Get all verified addresses for this user
            const addresses = user.verified_addresses?.eth_addresses || [];
            if (user.custody_address) addresses.push(user.custody_address);

            if (addresses.length === 0) {
              return { fid: user.fid, isHolder: false, reason: 'no addresses' };
            }

            // Check balance and cooldown amount in parallel
            const [balances, cooldownAmount] = await Promise.all([
              Promise.all(
                addresses.map(addr => token.balanceOf(addr).catch((e) => {
                  console.log(`Balance check failed for ${addr}: ${e.message}`);
                  return 0n;
                }))
              ),
              calculateCooldownAmount(addresses)
            ]);

            const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);

            // Eligible balance = total balance - tokens in cooldown
            const eligibleBalance = totalBalance > cooldownAmount ? totalBalance - cooldownAmount : 0n;
            const isHolder = eligibleBalance >= HOLDER_THRESHOLD;
            const hasCooldown = cooldownAmount > 0n;

            // Log if they would qualify but for cooldown
            if (hasCooldown && !isHolder && totalBalance >= HOLDER_THRESHOLD) {
              console.log(`Contest ${contestId}: User ${user.fid} (${user.username}) has ${formatTokenBalance(totalBalance)} but ${formatTokenBalance(cooldownAmount)} in cooldown. Eligible: ${formatTokenBalance(eligibleBalance)}`);
            }

            if (isHolder) {
              console.log(`Contest ${contestId}: User ${user.fid} (${user.username}) is a holder with ${formatTokenBalance(eligibleBalance)} eligible tokens`);
            }

            return { fid: user.fid, isHolder, inCooldown: hasCooldown && !isHolder, balance: totalBalance.toString(), eligibleBalance: eligibleBalance.toString() };
          } catch (e) {
            console.error(`Holder check failed for user ${user.fid}:`, e.message);
            return { fid: user.fid, isHolder: false, error: e.message };
          }
        })
      );
      holderChecks.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < users.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Log holder summary
    const holders = holderChecks.filter(c => c.isHolder);
    const cooldowns = holderChecks.filter(c => c.inCooldown);
    const repliers = Array.from(hasRepliedSet).length;
    console.log(`Contest ${contestId}: ${holders.length}/${holderChecks.length} users are holders, ${cooldowns.length} in cooldown, ${repliers} have replied`);

    // Build holder status map
    holderChecks.forEach(check => holderStatusMap.set(check.fid, check.isHolder));

    // Build debug info for troubleshooting (included in response when refresh=1)
    const debugInfo = forceRefresh ? {
      totalUsers: users.length,
      holdersFound: holders.length,
      repliersFound: repliers,
      holderDetails: holders.map(h => ({ fid: h.fid, balance: h.balance })),
      sampleUserAddresses: users.slice(0, 3).map(u => ({
        fid: u.fid,
        username: u.username,
        verified: u.verified_addresses?.eth_addresses || [],
        custody: u.custody_address || null
      }))
    } : null;

    // Check who has shared this contest
    const hasSharedSet = new Set();
    try {
      const shareFids = await kv.smembers(`contest_shares:${contestId}`);
      if (Array.isArray(shareFids)) {
        shareFids.forEach(fid => hasSharedSet.add(parseInt(fid)));
      }
      console.log(`Contest ${contestId}: Found ${hasSharedSet.size} users who shared`);
    } catch (shareError) {
      console.error('Error fetching sharers:', shareError.message);
    }

    // Map to participant objects with hasReplied, isHolder, hasShared, and entryCount
    const participants = users.map(user => {
      const hasReplied = hasRepliedSet.has(user.fid);
      const isHolder = holderStatusMap.get(user.fid) || false;
      const hasShared = hasSharedSet.has(user.fid);

      // Calculate entry count: base (1) + holder bonus (1) + reply bonus (1) + share bonus (1)
      // Note: Volume bonus is only checked at finalization time
      let entryCount = 1; // Base entry
      if (isHolder) entryCount++;
      if (hasReplied) entryCount++;
      if (hasShared) entryCount++;

      return {
        fid: user.fid,
        pfpUrl: user.pfp_url || null,
        username: user.username,
        hasReplied,
        isHolder,
        hasShared,
        entryCount
      };
    }).filter(p => p.pfpUrl); // Only include users with PFPs

    // Sort by entryCount descending for consistent display order
    participants.sort((a, b) => b.entryCount - a.entryCount);

    // Cache the participant data for consistent colors across reloads
    try {
      await kv.set(cacheKey, {
        participants,
        count: entryFids.length,
        cachedAt: Date.now()
      });
      console.log(`Contest ${contestId}: Cached ${participants.length} participants with entry counts`);
    } catch (cacheError) {
      console.error('Failed to cache participants:', cacheError.message);
    }

    const response = {
      participants,
      count: entryFids.length,
      displayed: participants.length
    };

    // Include debug info when force refresh is used
    if (debugInfo) {
      response.debug = debugInfo;
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Contest participants error:', error);
    return res.status(500).json({ error: error.message });
  }
};
