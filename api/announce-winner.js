/**
 * Winner Announcement API
 *
 * Checks for completed contests and posts winner announcements
 * as replies to the original cast.
 *
 * Supports the unified ContestManager (M- and T- prefix contests)
 * with multi-winner support for ETH/ERC20 and single winner for NFT.
 *
 * Usage:
 *   POST /api/announce-winner (cron - checks all completed contests)
 *   GET /api/announce-winner?contestId=M-1 (announce specific main contest)
 *   GET /api/announce-winner?contestId=T-1 (announce specific test contest)
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',

  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
};

// Unified ContestManager ABI
// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function mainNextContestId() view returns (uint256)',
  'function testNextContestId() view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const ERC721_ABI = [
  'function name() view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
];

const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 id) view returns (string)',
];

// Prize types from contract
const PRIZE_TYPES = { ETH: 0, ERC20: 1, ERC721: 2, ERC1155: 3 };
const CONTEST_STATUS = { Active: 0, PendingVRF: 1, Completed: 2, Cancelled: 3 };

/**
 * Parse contest ID string (M-1, T-1) into type and numeric ID
 */
function parseContestId(contestIdStr) {
  if (typeof contestIdStr === 'string') {
    if (contestIdStr.startsWith('M-')) {
      return { id: parseInt(contestIdStr.slice(2)), type: 'main' };
    }
    if (contestIdStr.startsWith('T-')) {
      return { id: parseInt(contestIdStr.slice(2)), type: 'test' };
    }
  }
  // Default to main if just a number
  return { id: parseInt(contestIdStr), type: 'main' };
}

/**
 * Fetch NFT image URL from contract tokenURI/uri
 */
async function fetchNftImage(nftContract, tokenId, isErc1155 = false) {
  try {
    if (!nftContract || tokenId === undefined) return null;

    console.log(`   Fetching NFT image from contract: ${nftContract} #${tokenId}`);

    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const contract = new ethers.Contract(nftContract, NFT_ABI, provider);

    let tokenUri = '';
    try {
      if (isErc1155) {
        tokenUri = await contract.uri(tokenId);
        tokenUri = tokenUri.replace('{id}', tokenId.toString().padStart(64, '0'));
      } else {
        tokenUri = await contract.tokenURI(tokenId);
      }
    } catch (e) {
      console.log(`   Error fetching tokenURI: ${e.message}`);
      return null;
    }

    // Handle different URI schemes
    let metadataUrl = tokenUri;
    if (tokenUri.startsWith('ipfs://')) {
      metadataUrl = tokenUri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
    } else if (tokenUri.startsWith('ar://')) {
      metadataUrl = tokenUri.replace('ar://', 'https://arweave.net/');
    } else if (tokenUri.startsWith('data:application/json')) {
      try {
        const base64Data = tokenUri.split(',')[1];
        const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
        const metadata = JSON.parse(jsonStr);
        let imageUrl = metadata.image || '';
        if (imageUrl.startsWith('ipfs://')) {
          imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
        }
        return imageUrl || null;
      } catch (e) {
        return null;
      }
    }

    // Fetch metadata from URL
    try {
      const response = await fetch(metadataUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) return null;
      const metadata = await response.json();

      let imageUrl = metadata.image || metadata.image_url || '';
      if (imageUrl.startsWith('ipfs://')) {
        imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
      } else if (imageUrl.startsWith('ar://')) {
        imageUrl = imageUrl.replace('ar://', 'https://arweave.net/');
      }

      return imageUrl || null;
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

// Track announced contests using KV
async function isAlreadyAnnounced(contestIdStr) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const announced = await kv.get(`announced_${contestIdStr}`);
      return !!announced;
    }
  } catch (e) {
    console.log('   Could not check announced status:', e.message);
  }
  return false;
}

async function markAsAnnounced(contestIdStr) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      await kv.set(`announced_${contestIdStr}`, true);
    }
  } catch (e) {
    console.log('   Could not mark as announced:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

async function getUserByWallet(walletAddress) {
  try {
    const normalizedAddress = walletAddress.toLowerCase();
    console.log(`   Looking up Farcaster user for wallet: ${normalizedAddress}`);

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${normalizedAddress}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    const users = data[normalizedAddress];

    if (users && users.length > 0) {
      const user = users[0];
      console.log(`   Found Farcaster user: @${user.username} (FID: ${user.fid})`);
      return user;
    }

    return null;
  } catch (error) {
    console.error('Error fetching user by wallet:', error);
    return null;
  }
}

async function postWinnerAnnouncement(quotedCastHash, message, signerUuid, nftImageUrl = null) {
  try {
    if (!signerUuid) {
      console.log('   No NEYNAR_SIGNER_UUID configured - cannot post cast');
      return { success: false, error: 'No signer configured' };
    }

    const quotedCastUrl = `https://warpcast.com/~/conversations/${quotedCastHash}`;
    const embeds = [{ url: quotedCastUrl }];

    if (nftImageUrl) {
      const proxiedImage = `https://frame-opal-eight.vercel.app/api/image-proxy?url=${encodeURIComponent(nftImageUrl)}`;
      embeds.push({ url: proxiedImage });
    }

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
    console.log('   Winner announcement posted!');
    return { success: true, castHash: data.cast?.hash };
  } catch (error) {
    console.error('Error posting cast:', error);
    return { success: false, error: error.message };
  }
}

async function getCustomMessage(contestIdStr) {
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const message = await kv.get(`contest_message_${contestIdStr}`);
      if (message) {
        console.log(`   Found custom message for contest ${contestIdStr}`);
        return message;
      }
    }
  } catch (e) {
    console.log('   Could not fetch custom message:', e.message);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ANNOUNCEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════

async function announceContestWinners(contestIdStr) {
  const { id, type } = parseContestId(contestIdStr);
  const prefix = type === 'test' ? 'T' : 'M';
  const fullContestId = `${prefix}-${id}`;

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);

  // Get contest details
  const contest = type === 'test'
    ? await contestManager.getTestContestFull(id)
    : await contestManager.getContestFull(id);

  // Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
  const {
    host, contestType, status, castId, prizeToken, prizeAmount, nftAmount, winnerCount, winners
  } = contest;
  // For NFT contests: prizeToken = NFT contract, prizeAmount = tokenId
  const prizeType = contestType; // Alias for compatibility

  // Check status
  if (Number(status) !== CONTEST_STATUS.Completed) {
    return {
      success: false,
      error: `Contest not completed (status: ${status})`,
      contestId: fullContestId
    };
  }

  if (!winners || winners.length === 0) {
    return {
      success: false,
      error: 'No winners set',
      contestId: fullContestId
    };
  }

  // Check if already announced
  if (await isAlreadyAnnounced(fullContestId)) {
    return {
      success: false,
      error: 'Already announced',
      contestId: fullContestId
    };
  }

  const isNftPrize = Number(prizeType) === PRIZE_TYPES.ERC721 || Number(prizeType) === PRIZE_TYPES.ERC1155;

  // For NFT contests: prizeToken = NFT contract, prizeAmount = tokenId
  const nftContract = isNftPrize ? prizeToken : null;
  const nftTokenId = isNftPrize ? prizeAmount : null;

  console.log(`\nAnnouncing ${winners.length} winner(s) for Contest ${fullContestId}`);
  console.log(`   Host: ${host}`);
  console.log(`   Winners: ${winners.join(', ')}`);

  // Get host's Farcaster profile
  const hostUser = await getUserByWallet(host);
  const hostTag = hostUser ? `@${hostUser.username}` : null;

  // Deduplicate winners
  const uniqueWinners = [...new Set(winners.map(w => w.toLowerCase()))];

  // Get all winners' Farcaster profiles
  const winnerProfiles = [];
  for (const winnerAddr of uniqueWinners) {
    const winnerUser = await getUserByWallet(winnerAddr);
    winnerProfiles.push({
      address: winnerAddr,
      user: winnerUser,
      tag: winnerUser ? `@${winnerUser.username}` : winnerAddr.slice(0, 10) + '...'
    });
  }

  // Get prize info
  let prizeDisplay = '';
  let perWinnerPrize = '';
  let nftImageUrl = null;
  const uniqueWinnerCount = uniqueWinners.length;

  if (Number(prizeType) === PRIZE_TYPES.ETH) {
    const totalEth = Number(ethers.formatEther(prizeAmount));
    const perWinner = totalEth / uniqueWinnerCount;
    prizeDisplay = `${totalEth.toFixed(4)} ETH`;
    perWinnerPrize = uniqueWinnerCount > 1 ? ` (${perWinner.toFixed(4)} ETH each)` : '';
  } else if (Number(prizeType) === PRIZE_TYPES.ERC20) {
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
  } else if (isNftPrize) {
    try {
      const nftContractInstance = new ethers.Contract(nftContract, ERC721_ABI, provider);
      const name = await nftContractInstance.name().catch(() => 'NFT');
      const isErc1155 = Number(prizeType) === PRIZE_TYPES.ERC1155;

      if (isErc1155) {
        prizeDisplay = `${Number(nftAmount)}x ${name} #${nftTokenId}`;
      } else {
        prizeDisplay = `${name} #${nftTokenId}`;
      }

      nftImageUrl = await fetchNftImage(nftContract, nftTokenId.toString(), isErc1155);
    } catch (e) {
      prizeDisplay = `NFT #${nftTokenId}`;
    }
  }

  // Get custom message and finalize TX
  const customMessage = await getCustomMessage(fullContestId);
  let finalizeTxHash = null;
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      finalizeTxHash = await kv.get(`finalize_tx_${fullContestId}`);
    }
  } catch (e) { /* ignore */ }

  // Build announcement message
  let announcement = isNftPrize
    ? `NFT CONTEST ${fullContestId} COMPLETE!\n\n`
    : `CONTEST ${fullContestId} COMPLETE!\n\n`;

  if (customMessage) {
    announcement += `${customMessage}\n\n`;
  }

  if (hostTag) {
    announcement += `Host: ${hostTag}\n`;
  }

  if (winners.length === 1) {
    announcement += `Winner: ${winnerProfiles[0].tag}\n`;
  } else {
    announcement += `Winners:\n`;
    winnerProfiles.forEach((wp, i) => {
      announcement += `   ${i + 1}. ${wp.tag}\n`;
    });
  }

  announcement += `Prize: ${prizeDisplay}${perWinnerPrize}\n`;
  announcement += `Selected via Chainlink VRF\n`;

  if (finalizeTxHash) {
    announcement += `https://basescan.org/tx/${finalizeTxHash}\n`;
  }

  announcement += `\nCongrats to ${winners.length === 1 ? 'the winner' : 'all winners'}!\n\n`;
  announcement += `Launch your own contest: https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes`;

  // Post the announcement
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!signerUuid) {
    console.log('   NEYNAR_SIGNER_UUID not set - skipping cast post');
    await markAsAnnounced(fullContestId);
    return {
      success: true,
      contestId: fullContestId,
      winners: winners,
      winnerUsernames: winnerProfiles.map(wp => wp.user?.username).filter(Boolean),
      prize: prizeDisplay,
      message: announcement,
      posted: false,
      note: 'Set NEYNAR_SIGNER_UUID to enable automatic cast posting'
    };
  }

  const postResult = await postWinnerAnnouncement(actualCastHash, announcement, signerUuid, nftImageUrl);

  if (postResult.success) {
    await markAsAnnounced(fullContestId);
  }

  return {
    success: postResult.success,
    contestId: fullContestId,
    winners: winners,
    winnerUsernames: winnerProfiles.map(wp => wp.user?.username).filter(Boolean),
    prize: prizeDisplay,
    message: announcement,
    posted: postResult.success,
    castHash: postResult.castHash
  };
}

/**
 * Check all contests and announce any completed ones
 */
async function checkAndAnnounceAll() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);
  const results = [];

  // Check main contests (M-)
  try {
    const mainNextId = await contestManager.mainNextContestId();
    console.log(`\nChecking Main contests 1 to ${mainNextId - 1n}...`);

    for (let i = 1n; i < mainNextId; i++) {
      try {
        const contest = await contestManager.getContestFull(i);
        const { status, winners } = contest;

        if (Number(status) === CONTEST_STATUS.Completed && winners && winners.length > 0) {
          const contestIdStr = `M-${i}`;
          if (!(await isAlreadyAnnounced(contestIdStr))) {
            const result = await announceContestWinners(contestIdStr);
            results.push(result);
          }
        }
      } catch (e) {
        console.log(`   Main Contest #${i} error:`, e.message?.slice(0, 50));
      }
    }
  } catch (e) {
    console.log('Could not check main contests:', e.message);
  }

  // Check test contests (T-)
  try {
    const testNextId = await contestManager.testNextContestId();
    console.log(`\nChecking Test contests 1 to ${testNextId - 1n}...`);

    for (let i = 1n; i < testNextId; i++) {
      try {
        const contest = await contestManager.getTestContestFull(i);
        const { status, winners } = contest;

        if (Number(status) === CONTEST_STATUS.Completed && winners && winners.length > 0) {
          const contestIdStr = `T-${i}`;
          if (!(await isAlreadyAnnounced(contestIdStr))) {
            const result = await announceContestWinners(contestIdStr);
            results.push(result);
          }
        }
      } catch (e) {
        console.log(`   Test Contest #${i} error:`, e.message?.slice(0, 50));
      }
    }
  } catch (e) {
    console.log('Could not check test contests:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// VERCEL API HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // GET: Announce specific contest
    // Usage: /api/announce-winner?contestId=M-1 or /api/announce-winner?contestId=T-1
    if (req.method === 'GET') {
      const contestId = req.query.contestId;

      if (!contestId) {
        return res.status(400).json({
          error: 'Missing contestId parameter (e.g., M-1 or T-1)'
        });
      }

      const result = await announceContestWinners(contestId);
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
    return res.status(500).json({ error: error.message });
  }
};

// For local testing
if (require.main === module) {
  const contestId = process.argv[2];

  if (contestId) {
    announceContestWinners(contestId)
      .then(result => {
        console.log('\nResult:', JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      });
  } else {
    checkAndAnnounceAll()
      .then(results => {
        console.log('\nResults:', JSON.stringify(results, null, 2));
        process.exit(0);
      });
  }
}
