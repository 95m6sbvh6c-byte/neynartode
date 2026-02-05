/**
 * Check Eligibility API
 *
 * Checks if a user qualifies for a specific contest based on:
 * - Volume requirements (trading activity during contest period)
 * - Social requirements (recast, like, reply on the cast)
 *
 * OPTIMIZED: Uses cached Neynar API calls and HTTP cache headers
 *
 * Usage:
 *   GET /api/check-eligibility?contestId=30&fid=12345
 *   GET /api/check-eligibility?contestId=30&address=0x...
 */

const { ethers } = require('ethers');
const { getUserAddresses: getCachedUserAddresses, getUserByWallet: getCachedUserByWallet, getCastReactions, getCastConversation } = require('./lib/utils');

const CONFIG = {
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  // Holder thresholds (in tokens with 18 decimals)
  HOLDER_THRESHOLD_DEFAULT: 100000000n * 10n**18n,  // 100M for NEYNARTODES contests
  HOLDER_THRESHOLD_CUSTOM: 200000000n * 10n**18n,   // 200M for custom token contests
  // Transfer cooldown for holder bonus (36 hours)
  TRANSFER_COOLDOWN_HOURS: 36,
};

// DEX addresses - transfers FROM these are purchases (no cooldown)
// Must match the whitelist in finalize-contest.js
const DEX_ADDRESSES = new Set([
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // Uniswap V3 Pool (NEYNARTODES/WETH)
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 SwapRouter02
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', // Uniswap Universal Router 2
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', // LI.FI Diamond
  '0x111111125421ca6dc452d289314280a0f8842a65', // 1inch v6 Router
  '0xdef1abe32c034e558cdd535791643c58a13acc10', // ParaSwap
  '0x6352a56caadc4f1e25cd6c75970fa768a3304e64', // Odos Router v2
  '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', // Jumper Exchange
  '0x5d64d14d2cf4fe5fe4e65b1c7e3d11e18d493091', // Zerion Router
  '0xdD7d485A334B13D3Ae589e00fa8248BEC21A7121', // Dexscreener moonshot
  '0x7b96E0f29241f3d654CA1BFBC53E1B0E5E3Ec211', // team.tode.eth
  // NEYNARTODES Treasury - host rewards from BuyBurnHoldEarn
  '0xd4d84f3477eb482783aAB48F00e357C801c48928',
  // BuyBurnHoldEarn v1 - contest entry rewards
  '0xCfa90CfE67Ca3a08f862671Bd7Fb808662efAC28',
  // BuyBurnHoldEarn v2 - contest entry rewards (old)
  '0x856Bc35576a38b8a9887E86888995F056fA87593',
  // BuyBurnHoldEarn v2 - contest entry rewards (fixed)
  '0x85D1A086E7119B9250f618077240BdA2cA3ecd72',
  // 0x Protocol Settlers - DEX aggregator addresses
  '0xdc5d8200A030798BC6227240f68b4dD9542686ef',  // Settler - Taker (swap)
  '0xce09Bdf28eC438FddE2Bf255dA806e0c357247bf',  // Settler - Metatransaction
  '0xFf11500b35A3e48a298BCd6139B9A3D9c369537e',  // Settler - Intents
  '0x706A7D84D3C17b63FF0DA2c38a8c178e00cD87Be',  // Settler - Bridge
  '0x0000000000001fF3684f28c67538d4D072C22734',  // 0x AllowanceHolder
  // Zero address (minting)
  '0x0000000000000000000000000000000000000000',
].map(a => a.toLowerCase()));

// Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
];

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Determine holder threshold based on contest type
 * - 100M for NEYNARTODES contests (rewards loyal holders)
 * - 200M for custom token contests (drives more volume to promoted projects)
 */
function getHolderThreshold(tokenRequirement) {
  const isNeynartodes = tokenRequirement.toLowerCase() === CONFIG.NEYNARTODES.toLowerCase();
  return {
    threshold: isNeynartodes ? CONFIG.HOLDER_THRESHOLD_DEFAULT : CONFIG.HOLDER_THRESHOLD_CUSTOM,
    thresholdFormatted: isNeynartodes ? '100M' : '200M',
    isCustomToken: !isNeynartodes
  };
}

/**
 * Calculate amount of tokens in cooldown (received via wallet-to-wallet transfer in last 36 hours)
 * Tokens from DEX purchases are NOT in cooldown
 * Returns the amount that should be subtracted from total balance for holder qualification
 */
async function calculateCooldownAmount(addresses, provider) {
  try {
    const currentBlock = await provider.getBlockNumber();
    const blocksIn36Hours = Math.ceil((CONFIG.TRANSFER_COOLDOWN_HOURS * 60 * 60) / 2); // ~2 sec blocks on Base
    const fromBlock = currentBlock - blocksIn36Hours;

    const neynartodes = new ethers.Contract(
      CONFIG.NEYNARTODES,
      ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      provider
    );

    // Query Transfer events TO user addresses in the cooldown period
    const transferPromises = addresses.map(addr =>
      neynartodes.queryFilter(neynartodes.filters.Transfer(null, addr), fromBlock, 'latest')
        .catch(e => {
          console.error(`Error querying transfers for ${addr}:`, e.message);
          return [];
        })
    );

    const allTransferArrays = await Promise.all(transferPromises);
    const allTransfers = allTransferArrays.flat();

    // Sum up transfers from non-DEX addresses (wallet-to-wallet transfers)
    let cooldownAmount = 0n;
    for (const event of allTransfers) {
      const fromAddr = event.args.from.toLowerCase();

      // Skip if transfer is from a DEX (those are purchases, not wallet transfers)
      if (DEX_ADDRESSES.has(fromAddr)) {
        continue;
      }

      // Skip if transfer is between user's own addresses
      if (addresses.includes(fromAddr)) {
        continue;
      }

      cooldownAmount += BigInt(event.args.value);
    }

    console.log(`Cooldown amount for addresses: ${formatTokenBalance(cooldownAmount)} tokens in cooldown`);
    return cooldownAmount;
  } catch (e) {
    console.error('Error calculating cooldown amount:', e.message);
    return 0n;
  }
}

/**
 * Check if user qualifies via NEYNARTODES token holdings
 * Sums balance across all verified addresses
 * Subtracts tokens in cooldown (received via wallet-to-wallet transfer in last 36hrs)
 * OPTIMIZED: Fetches all balances in parallel
 */
async function checkHolderQualification(addresses, provider, tokenRequirement) {
  const { threshold, thresholdFormatted, isCustomToken } = getHolderThreshold(tokenRequirement);

  const neynartodes = new ethers.Contract(
    CONFIG.NEYNARTODES,
    ERC20_ABI,
    provider
  );

  // Fetch balances and cooldown amount in PARALLEL
  const [balances, cooldownAmount] = await Promise.all([
    Promise.all(addresses.map(addr =>
      neynartodes.balanceOf(addr).catch(e => {
        console.error(`Error checking balance for ${addr}:`, e.message);
        return 0n;
      })
    )),
    calculateCooldownAmount(addresses, provider)
  ]);

  const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);

  // Eligible balance = total balance - tokens in cooldown
  // Can't go negative (in case of rounding or timing issues)
  const eligibleBalance = totalBalance > cooldownAmount ? totalBalance - cooldownAmount : 0n;

  const hasCooldown = cooldownAmount > 0n;

  return {
    met: eligibleBalance >= threshold,
    balance: totalBalance.toString(),
    balanceFormatted: formatTokenBalance(totalBalance),
    eligibleBalance: eligibleBalance.toString(),
    eligibleBalanceFormatted: formatTokenBalance(eligibleBalance),
    cooldownAmount: cooldownAmount.toString(),
    cooldownAmountFormatted: formatTokenBalance(cooldownAmount),
    hasCooldown: hasCooldown,
    threshold: threshold.toString(),
    thresholdFormatted: thresholdFormatted,
    remaining: eligibleBalance >= threshold ? '0' : (threshold - eligibleBalance).toString(),
    remainingFormatted: eligibleBalance >= threshold ? '0' : formatTokenBalance(threshold - eligibleBalance),
    isCustomToken: isCustomToken
  };
}

/**
 * Format token balance to human readable (e.g., 50M, 1.5B)
 */
function formatTokenBalance(balance) {
  const num = Number(balance / (10n ** 18n));
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toFixed(0);
}

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
 * Get user addresses from FID (uses cached version from utils)
 */
async function getUserAddresses(fid) {
  return getCachedUserAddresses(fid);
}

/**
 * Check social requirements (recast, like, reply)
 *
 * OPTIMIZED: Uses cached API calls from lib/utils.js
 * The cached functions return Sets of FIDs for quick lookup
 */
async function checkSocialRequirements(castHash, fid, requirements) {
  const result = {
    recasted: false,
    liked: false,
    replied: false,
  };

  try {
    console.log(`   Checking cast ${castHash.slice(0, 10)}... for FID ${fid}`);

    // Use cached API calls - they return Sets of FIDs for quick lookup
    const [reactions, conversation] = await Promise.all([
      getCastReactions(castHash, 'likes,recasts'),
      getCastConversation(castHash),
    ]);

    // Check if user's FID is in the reaction/reply sets
    result.liked = reactions.likerFids.has(fid);
    result.recasted = reactions.recasterFids.has(fid);
    result.replied = conversation.replierFids.has(fid);

    console.log(`   Result: recasted=${result.recasted}, liked=${result.liked}, replied=${result.replied}`);

  } catch (e) {
    console.error('Error checking social requirements:', e.message);
  }

  return result;
}

/**
 * Get transfers during contest period
 * OPTIMIZED: Fetches all addresses in parallel, batch fetches block timestamps
 * @param {string} tokenAddress - The token to check transfers for (custom or NEYNARTODES)
 */
async function getContestTransfers(provider, tokenAddress, addresses, fromBlock, toBlock) {
  const transfers = [];

  try {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      provider
    );

    // Fetch all sell and buy events for ALL addresses in PARALLEL
    const eventPromises = addresses.flatMap(addr => [
      tokenContract.queryFilter(tokenContract.filters.Transfer(addr, null), fromBlock, toBlock),
      tokenContract.queryFilter(tokenContract.filters.Transfer(null, addr), fromBlock, toBlock),
    ]);

    const allEventArrays = await Promise.all(eventPromises);
    const allEvents = allEventArrays.flat();

    if (allEvents.length === 0) {
      return transfers;
    }

    // Get unique block numbers and fetch timestamps in parallel
    const uniqueBlocks = [...new Set(allEvents.map(e => e.blockNumber))];
    const blockPromises = uniqueBlocks.map(blockNum =>
      provider.getBlock(blockNum).then(block => ({ blockNum, timestamp: block.timestamp }))
    );
    const blockResults = await Promise.all(blockPromises);

    // Create block timestamp lookup map
    const blockTimestamps = {};
    for (const { blockNum, timestamp } of blockResults) {
      blockTimestamps[blockNum] = timestamp;
    }

    // Build transfers array using cached timestamps
    for (const event of allEvents) {
      transfers.push({
        amount: Number(ethers.formatEther(event.args.value)),
        timestamp: blockTimestamps[event.blockNumber],
        blockNumber: event.blockNumber,
      });
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

  // Add HTTP cache headers (cache for 30 sec on CDN, 10 sec in browser)
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60, max-age=10');

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
      // Try to get FID from address (uses cached API call)
      try {
        const user = await getCachedUserByWallet(address);
        if (user) {
          userFid = user.fid;
          // Also get all their addresses
          if (user.custody_address) addresses.push(user.custody_address.toLowerCase());
          if (user.verified_addresses?.eth_addresses) {
            addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
          }
          addresses = [...new Set(addresses)];
        }
      } catch (e) {}
    }

    if (addresses.length === 0) {
      return res.status(400).json({ error: 'Could not find user addresses' });
    }

    // Get contest details from unified ContestManager
    // Contest ID format: M-1, T-1, etc.
    const isTestContest = contestId.startsWith('T-');
    const numericId = parseInt(contestId.replace(/^[MT]-/, ''));

    const contestContract = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);
    const contest = isTestContest
      ? await contestContract.getTestContestFull(numericId)
      : await contestContract.getContestFull(numericId);

    // Struct: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
    const contestStartTime = Number(contest.startTime);
    const contestEndTime = Number(contest.endTime);
    let castId = contest.castId;
    const tokenRequirement = contest.tokenRequirement;
    const volumeRequiredUSD = Number(contest.volumeRequirement) / 1e18;

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

    // Check holder, volume, AND social requirements in PARALLEL (they're independent)
    const [holder, volumeResult, social] = await Promise.all([
      // Holder check (skip volume if user holds enough NEYNARTODES)
      checkHolderQualification(addresses, provider, tokenRequirement),
      // Volume check
      (async () => {
        const transfers = await getContestTransfers(provider, tokenRequirement, addresses, fromBlock, currentBlock);
        return calculateVolumeUSD(provider, tokenRequirement, transfers, contestStartTime, contestEndTime);
      })(),
      // Social check
      userFid ? checkSocialRequirements(castHash, userFid, {
        requireRecast,
        requireLike,
        requireReply,
      }) : Promise.resolve({ recasted: false, liked: false, replied: false }),
    ]);

    const { volumeTokens, volumeUSD } = volumeResult;
    // Use small tolerance (1%) to handle floating point precision issues
    // e.g. $19.999 should count as meeting $20 requirement
    const volumeTolerance = volumeRequiredUSD * 0.01;
    const volumeMet = volumeRequiredUSD === 0 || volumeUSD >= (volumeRequiredUSD - volumeTolerance);

    const socialMet =
      (!requireRecast || social.recasted) &&
      (!requireLike || social.liked) &&
      (!requireReply || social.replied);

    // Qualification: (holder OR volume) AND social
    // Holders skip volume requirement, but still need social engagement
    const qualified = (holder.met || volumeMet) && socialMet;

    // Determine qualification reason for UI display
    let qualificationReason = 'not_qualified';
    if (qualified) {
      if (holder.met) qualificationReason = 'holder';
      else if (volumeRequiredUSD === 0) qualificationReason = 'no_requirement';
      else qualificationReason = 'volume';
    }

    return res.status(200).json({
      qualified,
      reason: qualificationReason,
      contestId: parseInt(contestId),
      holder: {
        met: holder.met,
        balance: holder.balance,
        balanceFormatted: holder.balanceFormatted,
        eligibleBalance: holder.eligibleBalance,
        eligibleBalanceFormatted: holder.eligibleBalanceFormatted,
        cooldownAmount: holder.cooldownAmount,
        cooldownAmountFormatted: holder.cooldownAmountFormatted,
        hasCooldown: holder.hasCooldown,
        threshold: holder.threshold,
        thresholdFormatted: holder.thresholdFormatted,
        remaining: holder.remaining,
        remainingFormatted: holder.remainingFormatted,
        isCustomToken: holder.isCustomToken,
      },
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
