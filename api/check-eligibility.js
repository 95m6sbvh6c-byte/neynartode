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
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
};

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
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
 *
 * FLOW:
 * 1. Check original post for engagement
 * 2. Find all quote casts of original post (host's reposts + others)
 * 3. Check each quote cast for engagement
 * 4. Deduplicate (user only needs to engage on ONE cast)
 */
async function checkSocialRequirements(castHash, fid, requirements) {
  const result = {
    recasted: false,
    liked: false,
    replied: false,
  };

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Check original post for engagement
    // ═══════════════════════════════════════════════════════════════════
    console.log(`   Step 1: Checking original cast ${castHash.slice(0, 10)}...`);

    const origReactionsResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${castHash}&types=likes,recasts&limit=100`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (origReactionsResponse.ok) {
      const origReactionsData = await origReactionsResponse.json();
      for (const reaction of origReactionsData.reactions || []) {
        if (reaction.user?.fid === fid) {
          if (reaction.reaction_type === 'like') result.liked = true;
          if (reaction.reaction_type === 'recast') result.recasted = true;
        }
      }
    }

    // Check replies on original
    const origRepliesResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${castHash}&type=hash&reply_depth=1&limit=50`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (origRepliesResponse.ok) {
      const origRepliesData = await origRepliesResponse.json();
      const replies = origRepliesData.conversation?.cast?.direct_replies || [];
      for (const reply of replies) {
        if (reply.author?.fid === fid) {
          const wordCount = (reply.text || '').trim().split(/\s+/).length;
          if (wordCount >= 2) {
            result.replied = true;
            break;
          }
        }
      }
    }

    console.log(`   After original: recasted=${result.recasted}, liked=${result.liked}, replied=${result.replied}`);

    // If already found all required engagement, return early
    if (result.recasted && result.liked && result.replied) {
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Find all quote casts of original post using Neynar API
    // ═══════════════════════════════════════════════════════════════════
    console.log(`   Step 2: Finding quote casts...`);
    const quoteCasts = [];

    // Use Neynar's dedicated cast quotes endpoint - returns ALL casts that quote the original
    const quotesResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/quotes?identifier=${castHash}&type=hash&limit=100`,
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

    console.log(`   Found ${quoteCasts.length} quote casts to check`);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Check each quote cast for engagement
    // ═══════════════════════════════════════════════════════════════════
    for (const quoteHash of quoteCasts) {
      // Stop early if we've found all engagement
      if (result.recasted && result.liked && result.replied) break;

      console.log(`   Step 3: Checking quote cast ${quoteHash.slice(0, 10)}...`);

      // Check reactions
      if (!result.recasted || !result.liked) {
        const reactionsResponse = await fetch(
          `https://api.neynar.com/v2/farcaster/reactions/cast?hash=${quoteHash}&types=likes,recasts&limit=100`,
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

      // Check replies
      if (!result.replied) {
        const repliesResponse = await fetch(
          `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${quoteHash}&type=hash&reply_depth=1&limit=50`,
          { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
        );

        if (repliesResponse.ok) {
          const repliesData = await repliesResponse.json();
          const replies = repliesData.conversation?.cast?.direct_replies || [];
          for (const reply of replies) {
            if (reply.author?.fid === fid) {
              const wordCount = (reply.text || '').trim().split(/\s+/).length;
              if (wordCount >= 2) {
                result.replied = true;
                break;
              }
            }
          }
        }
      }

      console.log(`   After ${quoteHash.slice(0, 10)}: recasted=${result.recasted}, liked=${result.liked}, replied=${result.replied}`);
    }

  } catch (e) {
    console.error('Error checking social requirements:', e.message);
  }

  return result;
}

/**
 * Get transfers during contest period
 * @param {string} tokenAddress - The token to check transfers for (custom or NEYNARTODES)
 */
async function getContestTransfers(provider, tokenAddress, addresses, fromBlock, toBlock) {
  const transfers = [];

  try {
    const tokenContract = new ethers.Contract(
      tokenAddress, // Use the contest's token requirement
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
 * Calculate volume in USD using historical prices at time of each trade
 * @param {string} tokenAddress - Token to get price for (custom or NEYNARTODES)
 */
async function calculateVolumeUSD(provider, tokenAddress, transfers, startTime, endTime) {
  let volumeTokens = 0;
  let volumeUSD = 0;

  // Cache prices by block to avoid redundant calls
  const priceCache = new Map();

  for (const tx of transfers) {
    if (tx.timestamp >= startTime && tx.timestamp <= endTime) {
      volumeTokens += tx.amount;

      // Get historical price at the block when trade occurred
      let price = priceCache.get(tx.blockNumber);
      if (price === undefined) {
        price = await getHistoricalTokenPriceForAddress(provider, tokenAddress, tx.blockNumber);
        priceCache.set(tx.blockNumber, price);
      }

      volumeUSD += tx.amount * price;
    }
  }

  return { volumeTokens, volumeUSD };
}

/**
 * Get token price for any token address (custom or NEYNARTODES)
 */
async function getTokenPriceForAddress(provider, tokenAddress) {
  // If it's NEYNARTODES, use the V4 pool we know about
  if (tokenAddress.toLowerCase() === CONFIG.NEYNARTODES.toLowerCase()) {
    return await getTokenPriceUSD(provider);
  }

  // For custom tokens, try to find a Uniswap V2/V3 pool with WETH
  const WETH = '0x4200000000000000000000000000000000000006';
  const ethPriceUSD = await getETHPriceUSD(provider);

  // Try V2 factories
  const V2_FACTORIES = [
    '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2 on Base
    '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome
  ];

  const V2_FACTORY_ABI = ['function getPair(address, address) view returns (address)'];
  const V2_PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)'
  ];

  for (const factoryAddr of V2_FACTORIES) {
    try {
      const factory = new ethers.Contract(factoryAddr, V2_FACTORY_ABI, provider);
      const pairAddress = await factory.getPair(tokenAddress, WETH);

      if (pairAddress && pairAddress !== '0x0000000000000000000000000000000000000000') {
        const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
        const [token0, reserves] = await Promise.all([
          pair.token0(),
          pair.getReserves()
        ]);

        const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
        const tokenReserve = isToken0 ? reserves.reserve0 : reserves.reserve1;
        const ethReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;

        if (tokenReserve > 0n && ethReserve > 0n) {
          const tokenPriceInETH = Number(ethReserve) / Number(tokenReserve);
          return tokenPriceInETH * ethPriceUSD;
        }
      }
    } catch (e) {
      // Continue to next factory
    }
  }

  // Try V3
  const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
  const V3_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
  const feeTiers = [10000, 3000, 500];

  for (const fee of feeTiers) {
    try {
      const v3Factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, provider);
      const poolAddress = await v3Factory.getPool(tokenAddress, WETH, fee);

      if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
        const poolABI = [
          'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
          'function token0() view returns (address)'
        ];
        const pool = new ethers.Contract(poolAddress, poolABI, provider);
        const [slot0, token0] = await Promise.all([pool.slot0(), pool.token0()]);

        const sqrtPriceX96 = slot0.sqrtPriceX96;
        const price = Number(sqrtPriceX96) / (2 ** 96);
        const priceSquared = price * price;
        const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
        const tokenPriceInETH = isToken0 ? priceSquared : 1 / priceSquared;

        return tokenPriceInETH * ethPriceUSD;
      }
    } catch (e) {
      // Continue to next fee tier
    }
  }

  console.log(`Could not find price for token ${tokenAddress}`);
  return 0;
}

/**
 * Get historical token price at a specific block
 * @param {string} tokenAddress - Token to get price for
 * @param {number} blockNumber - Block number to get price at
 */
async function getHistoricalTokenPriceForAddress(provider, tokenAddress, blockNumber) {
  const WETH = '0x4200000000000000000000000000000000000006';

  try {
    // Get ETH price (use current - Chainlink doesn't easily support historical)
    const ethPriceUSD = await getETHPriceUSD(provider);

    // If it's NEYNARTODES, use the V4 pool with historical block
    if (tokenAddress.toLowerCase() === CONFIG.NEYNARTODES.toLowerCase()) {
      try {
        const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);
        const slot0 = await stateView.getSlot0(CONFIG.NEYNARTODES_POOL_ID, { blockTag: blockNumber });

        if (slot0.sqrtPriceX96 === 0n) {
          return await getTokenPriceForAddress(provider, tokenAddress); // Fallback to current
        }

        const sqrtPriceX96 = slot0.sqrtPriceX96;
        const price = Number(sqrtPriceX96) / (2 ** 96);
        const priceSquared = price * price;
        const priceInETH = 1 / priceSquared;
        return priceInETH * ethPriceUSD;
      } catch (e) {
        return await getTokenPriceForAddress(provider, tokenAddress); // Fallback to current
      }
    }

    // For custom tokens, try V2 pools with historical block
    const V2_FACTORIES = [
      '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2 on Base
      '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome
    ];

    const V2_FACTORY_ABI = ['function getPair(address, address) view returns (address)'];
    const V2_PAIR_ABI = [
      'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
      'function token0() view returns (address)'
    ];

    for (const factoryAddr of V2_FACTORIES) {
      try {
        const factory = new ethers.Contract(factoryAddr, V2_FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(tokenAddress, WETH);

        if (pairAddress && pairAddress !== '0x0000000000000000000000000000000000000000') {
          const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
          const [token0, reserves] = await Promise.all([
            pair.token0(),
            pair.getReserves({ blockTag: blockNumber }) // Historical reserves
          ]);

          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
          const tokenReserve = isToken0 ? reserves.reserve0 : reserves.reserve1;
          const ethReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;

          if (tokenReserve > 0n && ethReserve > 0n) {
            const tokenPriceInETH = Number(ethReserve) / Number(tokenReserve);
            return tokenPriceInETH * ethPriceUSD;
          }
        }
      } catch (e) {
        // Continue to next factory
      }
    }

    // Try V3 with historical block
    const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
    const V3_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
    const feeTiers = [10000, 3000, 500];

    for (const fee of feeTiers) {
      try {
        const v3Factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, provider);
        const poolAddress = await v3Factory.getPool(tokenAddress, WETH, fee);

        if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
          const poolABI = [
            'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
            'function token0() view returns (address)'
          ];
          const pool = new ethers.Contract(poolAddress, poolABI, provider);
          const [slot0, token0] = await Promise.all([
            pool.slot0({ blockTag: blockNumber }), // Historical slot0
            pool.token0()
          ]);

          const sqrtPriceX96 = slot0.sqrtPriceX96;
          const price = Number(sqrtPriceX96) / (2 ** 96);
          const priceSquared = price * price;
          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
          const tokenPriceInETH = isToken0 ? priceSquared : 1 / priceSquared;

          return tokenPriceInETH * ethPriceUSD;
        }
      } catch (e) {
        // Continue to next fee tier
      }
    }
  } catch (e) {
    console.error(`Error getting historical price at block ${blockNumber}:`, e.message);
  }

  // Fallback to current price if historical lookup fails
  return await getTokenPriceForAddress(provider, tokenAddress);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { contestId, fid, address, nft } = req.query;
  const isNftContest = nft === 'true' || nft === '1';

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

    // Get contest details - use different contract for NFT contests
    let contestStartTime, contestEndTime, castId, tokenRequirement, volumeRequiredUSD;

    if (isNftContest) {
      const nftContract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_CONTEST_ESCROW_ABI, provider);
      const contest = await nftContract.getContest(contestId);
      // NFT contract returns: host, nftType, nftContract, tokenId, amount, startTime, endTime, castId, tokenRequirement, volumeRequirement, status, winner
      contestStartTime = Number(contest[5]);
      contestEndTime = Number(contest[6]);
      castId = contest[7];
      tokenRequirement = contest[8]; // Token address for volume requirement
      volumeRequiredUSD = Number(contest[9]) / 1e18;
    } else {
      const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
      const contest = await contract.getContest(contestId);
      const [, , , startTime, endTime, castIdVal, tokenReq, volumeReq] = contest;
      contestStartTime = Number(startTime);
      contestEndTime = Number(endTime);
      castId = castIdVal;
      tokenRequirement = tokenReq; // Token address for volume requirement
      volumeRequiredUSD = Number(volumeReq) / 1e18;
    }

    console.log(`Contest ${contestId} token requirement: ${tokenRequirement}`);

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

    // Check volume - use the contest's tokenRequirement (could be custom token or NEYNARTODES)
    const transfers = await getContestTransfers(provider, tokenRequirement, addresses, fromBlock, currentBlock);
    const { volumeTokens, volumeUSD } = await calculateVolumeUSD(
      provider, tokenRequirement, transfers, contestStartTime, contestEndTime
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
