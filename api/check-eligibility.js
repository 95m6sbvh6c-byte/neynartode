/**
 * Check Eligibility API
 *
 * Checks if a user qualifies for a specific contest based on:
 * - Volume requirements (trading activity during contest period)
 * - Social requirements (recast, like, reply on the cast)
 *
 * Usage:
 *   GET /api/check-eligibility?contestId=30&fid=12345
 *   GET /api/check-eligibility?contestId=30&address=0x...
 */

const { ethers } = require('ethers');

const CONFIG = {
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

/**
 * Get ETH price in USD
 */
async function getETHPriceUSD(provider) {
  try {
    const priceFeed = new ethers.Contract(CONFIG.CHAINLINK_ETH_USD, CHAINLINK_ABI, provider);
    const roundData = await priceFeed.latestRoundData();
    return Number(roundData.answer) / 1e8;
  } catch (e) {
    return 3500;
  }
}

/**
 * Get NEYNARTODES price in USD
 */
async function getTokenPriceUSD(provider) {
  try {
    const ethPriceUSD = await getETHPriceUSD(provider);
    const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);
    const slot0 = await stateView.getSlot0(CONFIG.NEYNARTODES_POOL_ID);

    if (slot0.sqrtPriceX96 === 0n) return 0;

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;
    const priceInETH = 1 / priceSquared;
    return priceInETH * ethPriceUSD;
  } catch (e) {
    return 0;
  }
}

/**
 * Get historical price at a specific block
 */
async function getHistoricalTokenPriceUSD(provider, blockNumber) {
  try {
    const ethPriceUSD = await getETHPriceUSD(provider);
    const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);
    const slot0 = await stateView.getSlot0(CONFIG.NEYNARTODES_POOL_ID, { blockTag: blockNumber });

    if (slot0.sqrtPriceX96 === 0n) return 0;

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;
    const priceInETH = 1 / priceSquared;
    return priceInETH * ethPriceUSD;
  } catch (e) {
    return await getTokenPriceUSD(provider);
  }
}

/**
 * Get user addresses from FID
 */
async function getUserAddresses(fid) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );
    if (!response.ok) return [];

    const data = await response.json();
    const user = data.users?.[0];
    if (!user) return [];

    const addresses = [];
    if (user.custody_address) addresses.push(user.custody_address.toLowerCase());
    if (user.verified_addresses?.eth_addresses) {
      addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
    }
    return addresses;
  } catch (e) {
    return [];
  }
}

/**
 * Check social requirements (recast, like, reply)
 * Also checks reactions on quote casts of the original cast
 */
async function checkSocialRequirements(castHash, fid, requirements) {
  const result = {
    recasted: false,
    liked: false,
    replied: false,
  };

  try {
    // Build list of casts to check (original + quote casts)
    const castsToCheck = [castHash];

    // Get quote casts of the original cast
    try {
      const quotesResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/cast?identifier=${castHash}&type=hash`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (quotesResponse.ok) {
        const castData = await quotesResponse.json();
        // The cast object has a "quotes" field with quote cast hashes
        // Also check conversation for quotes
        const conversationResponse = await fetch(
          `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castHash}&type=hash&reply_depth=1&include_chronological_parent_casts=false&limit=50`,
          { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
        );

        if (conversationResponse.ok) {
          const convData = await conversationResponse.json();
          // Check for quote casts in replies (they have embeds with the original cast)
          const replies = convData.conversation?.cast?.direct_replies || [];
          for (const reply of replies) {
            // Quote casts have the original cast in their embeds
            if (reply.embeds?.some(e => e.cast_id?.hash === castHash || e.cast?.hash === castHash)) {
              castsToCheck.push(reply.hash);
            }
          }
        }
      }

      // Also search for casts that embed/quote this cast
      const searchResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/cast/search?q=${castHash}&limit=25`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        for (const cast of searchData.result?.casts || []) {
          // Check if this cast quotes our original
          if (cast.embeds?.some(e => e.cast_id?.hash === castHash || e.cast?.hash === castHash || e.url?.includes(castHash))) {
            if (!castsToCheck.includes(cast.hash)) {
              castsToCheck.push(cast.hash);
            }
          }
        }
      }
    } catch (e) {
      console.error('Error fetching quote casts:', e.message);
    }

    console.log(`Checking ${castsToCheck.length} casts for eligibility (1 original + ${castsToCheck.length - 1} quote casts)`);

    // Check reactions on all casts (original + quote casts)
    for (const hash of castsToCheck) {
      if (result.recasted && result.liked) break; // Already found both

      const reactionsResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${hash}&types=likes,recasts&limit=100`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (reactionsResponse.ok) {
        const reactionsData = await reactionsResponse.json();
        for (const reaction of reactionsData.reactions || []) {
          if (reaction.user?.fid === fid) {
            if (reaction.reaction_type === 'like') result.liked = true;
            if (reaction.reaction_type === 'recast') result.recasted = true;
          }
        }
      }
    }

    // Check replies on all casts (original + quote casts)
    for (const hash of castsToCheck) {
      if (result.replied) break; // Already found

      const repliesResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${hash}&type=hash&reply_depth=1&limit=50`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (repliesResponse.ok) {
        const repliesData = await repliesResponse.json();
        const replies = repliesData.conversation?.cast?.direct_replies || [];
        for (const reply of replies) {
          if (reply.author?.fid === fid) {
            const wordCount = (reply.text || '').trim().split(/\s+/).length;
            if (wordCount >= 4) {
              result.replied = true;
              break;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Error checking social requirements:', e.message);
  }

  return result;
}

/**
 * Get transfers during contest period
 */
async function getContestTransfers(provider, addresses, fromBlock, toBlock) {
  const transfers = [];

  try {
    const tokenContract = new ethers.Contract(
      CONFIG.NEYNARTODES,
      ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      provider
    );

    for (const addr of addresses) {
      // Sells
      const sellEvents = await tokenContract.queryFilter(
        tokenContract.filters.Transfer(addr, null),
        fromBlock,
        toBlock
      );

      for (const event of sellEvents) {
        const block = await event.getBlock();
        transfers.push({
          amount: Number(ethers.formatEther(event.args.value)),
          timestamp: block.timestamp,
          blockNumber: event.blockNumber,
        });
      }

      // Buys
      const buyEvents = await tokenContract.queryFilter(
        tokenContract.filters.Transfer(null, addr),
        fromBlock,
        toBlock
      );

      for (const event of buyEvents) {
        const block = await event.getBlock();
        transfers.push({
          amount: Number(ethers.formatEther(event.args.value)),
          timestamp: block.timestamp,
          blockNumber: event.blockNumber,
        });
      }
    }
  } catch (e) {
    console.error('Error fetching transfers:', e.message);
  }

  return transfers;
}

/**
 * Calculate volume in USD using historical prices
 */
async function calculateVolumeUSD(provider, transfers, startTime, endTime) {
  let volumeTokens = 0;
  let volumeUSD = 0;

  for (const tx of transfers) {
    if (tx.timestamp >= startTime && tx.timestamp <= endTime) {
      volumeTokens += tx.amount;
      const price = await getHistoricalTokenPriceUSD(provider, tx.blockNumber);
      volumeUSD += tx.amount * price;
    }
  }

  return { volumeTokens, volumeUSD };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { contestId, fid, address } = req.query;

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  if (!fid && !address) {
    return res.status(400).json({ error: 'Missing fid or address' });
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Get user addresses
    let addresses = [];
    let userFid = parseInt(fid);

    if (fid) {
      addresses = await getUserAddresses(fid);
    } else if (address) {
      addresses = [address.toLowerCase()];
      // Try to get FID from address
      try {
        const response = await fetch(
          `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address.toLowerCase()}`,
          { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
        );
        if (response.ok) {
          const data = await response.json();
          const users = data[address.toLowerCase()];
          if (users && users.length > 0) {
            userFid = users[0].fid;
            // Also get all their addresses
            if (users[0].custody_address) addresses.push(users[0].custody_address.toLowerCase());
            if (users[0].verified_addresses?.eth_addresses) {
              addresses.push(...users[0].verified_addresses.eth_addresses.map(a => a.toLowerCase()));
            }
            addresses = [...new Set(addresses)];
          }
        }
      } catch (e) {}
    }

    if (addresses.length === 0) {
      return res.status(400).json({ error: 'Could not find user addresses' });
    }

    // Get contest details
    const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
    const contest = await contract.getContest(contestId);
    const [, , , startTime, endTime, castId, , volumeReq, status] = contest;

    const contestStartTime = Number(startTime);
    const contestEndTime = Number(endTime);
    const volumeRequiredUSD = Number(volumeReq) / 1e18;

    // Parse cast hash and requirements from castId
    let castHash = castId;
    let requireRecast = true, requireLike = false, requireReply = true;

    if (castId.includes('|')) {
      const [hash, reqCode] = castId.split('|');
      castHash = hash;
      if (reqCode) {
        const recastMatch = reqCode.match(/R(\d)/);
        const likeMatch = reqCode.match(/L(\d)/);
        const replyMatch = reqCode.match(/P(\d)/);
        if (recastMatch) requireRecast = recastMatch[1] !== '0';
        if (likeMatch) requireLike = likeMatch[1] !== '0';
        if (replyMatch) requireReply = replyMatch[1] !== '0';
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const currentBlock = await provider.getBlockNumber();

    // Calculate block range for contest
    const elapsedTime = now - contestStartTime;
    const blocksElapsed = Math.floor(elapsedTime / 2);
    const fromBlock = Math.max(0, currentBlock - blocksElapsed);

    // Check volume
    const transfers = await getContestTransfers(provider, addresses, fromBlock, currentBlock);
    const { volumeTokens, volumeUSD } = await calculateVolumeUSD(
      provider, transfers, contestStartTime, contestEndTime
    );
    const volumeMet = volumeRequiredUSD === 0 || volumeUSD >= volumeRequiredUSD;

    // Check social requirements
    const social = userFid ? await checkSocialRequirements(castHash, userFid, {
      requireRecast,
      requireLike,
      requireReply,
    }) : { recasted: false, liked: false, replied: false };

    const socialMet =
      (!requireRecast || social.recasted) &&
      (!requireLike || social.liked) &&
      (!requireReply || social.replied);

    const qualified = volumeMet && socialMet;

    return res.status(200).json({
      qualified,
      contestId: parseInt(contestId),
      volume: {
        met: volumeMet,
        tokens: volumeTokens,
        usd: volumeUSD,
        required: volumeRequiredUSD,
      },
      social: {
        met: socialMet,
        recasted: social.recasted,
        liked: social.liked,
        replied: social.replied,
        requirements: {
          recast: requireRecast,
          like: requireLike,
          reply: requireReply,
        },
      },
    });

  } catch (error) {
    console.error('Check eligibility error:', error);
    return res.status(500).json({ error: error.message });
  }
};
