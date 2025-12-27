/**
 * Uniswap Volume Checker
 *
 * Queries swap events from Uniswap V2, V3, and V4 pools on Base
 * to calculate trading volume for specific wallets.
 *
 * NEYNARTODES Token: 0x8de1622fe07f56cda2e2273e615a513f1d828b07
 *
 * Flow:
 * 1. Query Swap events from all pool types
 * 2. Filter by wallet addresses (from social qualification)
 * 3. Sum USD volume per wallet during contest period
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// CACHING - Avoid redundant RPC calls
// ═══════════════════════════════════════════════════════════════════

// Cache ETH price for 60 seconds (price doesn't change that fast)
let cachedETHPrice = null;
let ethPriceCacheTime = 0;
const ETH_PRICE_CACHE_TTL = 60 * 1000; // 60 seconds

// Cache V4 pool prices for 30 seconds
const v4PriceCache = new Map();
const V4_PRICE_CACHE_TTL = 30 * 1000; // 30 seconds

// ═══════════════════════════════════════════════════════════════════
// RETRY LOGIC - Handle transient RPC failures
// ═══════════════════════════════════════════════════════════════════

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} baseDelay - Base delay in ms (default: 500)
 * @returns {Promise} - Result of the function
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 500) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.code === 'TIMEOUT' ||
        error.code === 'SERVER_ERROR' ||
        error.code === 'NETWORK_ERROR' ||
        error.message?.includes('rate limit') ||
        error.message?.includes('429') ||
        error.message?.includes('timeout') ||
        error.message?.includes('ECONNRESET');

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`   RPC retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  WETH: '0x4200000000000000000000000000000000000006', // Base WETH

  // Known NEYNARTODES pools on Base
  POOLS: {
    // Uniswap V2 style (includes forks like Aerodrome)
    V2: [
      // Add known V2 pool addresses here
    ],
    // Uniswap V3
    V3: [
      // Add known V3 pool addresses here
    ],
    // Uniswap V4 (hooks-based)
    V4: [
      // V4 uses PoolManager - we'll query the PoolManager contract
    ]
  },

  // Uniswap V2 Factory (and forks)
  V2_FACTORIES: [
    '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2 on Base
    '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome (V2 style)
  ],

  // Uniswap V3 Factory
  V3_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',

  // Uniswap V4 PoolManager on Base
  V4_POOL_MANAGER: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
};

// ═══════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════

// Uniswap V2 Pair ABI (Swap event)
const V2_PAIR_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

// Uniswap V2 Factory ABI
const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

// Uniswap V3 Pool ABI (Swap event)
const V3_POOL_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
];

// Uniswap V3 Factory ABI
const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

// Uniswap V4 PoolManager ABI (Swap event)
const V4_POOL_MANAGER_ABI = [
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
];

// V4 StateView ABI for reading pool state (Clanker tokens use V4)
const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

// V4 StateView address on Base
const V4_STATE_VIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';

/**
 * Registry of known V4 pool IDs for tokens
 * Since Clanker tokens use various hook addresses that we can't easily discover,
 * we maintain a registry of known pool IDs for important tokens.
 * Format: tokenAddress (lowercase) -> { poolId, isToken0 (is token currency0 vs WETH) }
 */
const KNOWN_V4_POOLS = {
  // NEYNARTODES - Clanker-launched token with custom hook
  '0x8de1622fe07f56cda2e2273e615a513f1d828b07': {
    poolId: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
    isToken0: false, // WETH (0x42...) < NEYNARTODES (0x8d...), so token is currency1
  },
};

/**
 * Compute V4 poolId from currency pair and fee
 * V4 uses PoolKey: (currency0, currency1, fee, tickSpacing, hooks)
 */
function computeV4PoolId(token0, token1, fee, tickSpacing, hooks) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [token0, token1, fee, tickSpacing, hooks]
  );
  return ethers.keccak256(encoded);
}

/**
 * Try to get price from known V4 pool ID
 * This is for tokens where we know the pool ID but not the hook address
 * Uses caching to reduce RPC calls
 * @param {Object} options - Optional settings
 * @param {number} options.blockNumber - Block number for historical price lookup
 */
async function tryKnownV4Pool(provider, tokenAddress, ethPriceUSD, options = {}) {
  const knownPool = KNOWN_V4_POOLS[tokenAddress.toLowerCase()];
  if (!knownPool) return null;

  const blockNumber = options.blockNumber;

  // Check cache first (only for current price, not historical)
  const cacheKey = blockNumber ? `${tokenAddress.toLowerCase()}_${blockNumber}` : tokenAddress.toLowerCase();
  const now = Date.now();
  const cached = v4PriceCache.get(cacheKey);
  if (cached && (now - cached.time) < V4_PRICE_CACHE_TTL) {
    const cachedUSD = cached.priceInETH * ethPriceUSD;
    return cachedUSD;
  }

  const stateView = new ethers.Contract(V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  try {
    // Query at specific block if provided (historical price)
    const callOptions = blockNumber ? { blockTag: blockNumber } : {};
    const slot0 = await withRetry(() => stateView.getSlot0(knownPool.poolId, callOptions));

    // If sqrtPriceX96 is 0, pool doesn't have liquidity
    if (slot0.sqrtPriceX96 === 0n) return null;

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;

    // Determine price based on token position
    let priceInETH;
    if (knownPool.isToken0) {
      // Token is currency0, sqrtPrice gives us currency1/currency0 = WETH/Token
      priceInETH = priceSquared;
    } else {
      // Token is currency1, sqrtPrice gives us currency1/currency0 = Token/WETH
      // We need WETH/Token, so invert
      priceInETH = 1 / priceSquared;
    }

    // Cache the result
    v4PriceCache.set(cacheKey, { priceInETH, time: now });

    if (!blockNumber) {
      console.log(`   V4 (known pool) price: ${priceInETH.toFixed(12)} ETH ($${(priceInETH * ethPriceUSD).toFixed(8)})`);
    }
    return priceInETH * ethPriceUSD;
  } catch (e) {
    if (!blockNumber) {
      console.log('   Known V4 pool error:', e.message?.slice(0, 50));
    }
    return null;
  }
}

/**
 * Try to get price from V4 pool (Clanker tokens)
 */
async function tryV4PriceUSD(provider, tokenAddress, ethPriceUSD) {
  // First, check if we have a known pool ID for this token
  const knownPoolPrice = await tryKnownV4Pool(provider, tokenAddress, ethPriceUSD);
  if (knownPoolPrice) return knownPoolPrice;

  // Common Clanker hook addresses on Base
  // From Clanker docs: ClankerHook, ClankerHookStaticFee, ClankerHookDynamicFee, V2 variants
  const CLANKER_HOOKS = [
    '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC', // Current Clanker production hook
    '0x1eD8c4907aEF90aA7506eB553af519b8a4545772', // Clanker V1 hook
    '0x0000000000000000000000000000000000000000', // No hook
  ];

  // Common V4 fee tiers and tick spacings
  const V4_CONFIGS = [
    { fee: 10000, tickSpacing: 200 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 500, tickSpacing: 10 },
    { fee: 100, tickSpacing: 1 },
  ];

  const stateView = new ethers.Contract(V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  // Sort tokens to get correct order
  const [currency0, currency1] = tokenAddress.toLowerCase() < CONFIG.WETH.toLowerCase()
    ? [tokenAddress, CONFIG.WETH]
    : [CONFIG.WETH, tokenAddress];

  const isToken0 = tokenAddress.toLowerCase() === currency0.toLowerCase();

  for (const hook of CLANKER_HOOKS) {
    for (const config of V4_CONFIGS) {
      try {
        const poolId = computeV4PoolId(currency0, currency1, config.fee, config.tickSpacing, hook);
        const slot0 = await stateView.getSlot0(poolId);

        if (slot0.sqrtPriceX96 === 0n) continue;

        const sqrtPriceX96 = slot0.sqrtPriceX96;
        const price = Number(sqrtPriceX96) / (2 ** 96);
        const priceSquared = price * price;

        let tokenPriceInETH;
        if (isToken0) {
          tokenPriceInETH = priceSquared;
        } else {
          tokenPriceInETH = 1 / priceSquared;
        }

        const hookName = hook === '0x0000000000000000000000000000000000000000' ? 'native' : 'Clanker';
        console.log(`   V4 (${hookName} ${config.fee/10000}%) price: ${tokenPriceInETH.toFixed(12)} ETH ($${(tokenPriceInETH * ethPriceUSD).toFixed(8)})`);
        return tokenPriceInETH * ethPriceUSD;
      } catch (e) {
        // Continue to next config
      }
    }
  }

  return null;
}

// ERC20 ABI for decimals
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ═══════════════════════════════════════════════════════════════════
// POOL DISCOVERY
// ═══════════════════════════════════════════════════════════════════

/**
 * Find all V2-style pools for a token
 */
async function findV2Pools(provider, tokenAddress) {
  const pools = [];
  const pairedTokens = [CONFIG.WETH]; // Most common pair

  for (const factoryAddress of CONFIG.V2_FACTORIES) {
    try {
      const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);

      for (const pairedToken of pairedTokens) {
        try {
          const pairAddress = await factory.getPair(tokenAddress, pairedToken);
          if (pairAddress && pairAddress !== ethers.ZeroAddress) {
            pools.push({
              address: pairAddress,
              factory: factoryAddress,
              type: 'V2'
            });
            console.log(`   Found V2 pool: ${pairAddress}`);
          }
        } catch (e) {
          // Pool doesn't exist for this pair
        }
      }
    } catch (e) {
      console.log(`   V2 factory ${factoryAddress.slice(0,10)}... error: ${e.message}`);
    }
  }

  return pools;
}

/**
 * Find all V3 pools for a token (checks common fee tiers)
 */
async function findV3Pools(provider, tokenAddress) {
  const pools = [];
  const pairedTokens = [CONFIG.WETH];
  const feeTiers = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

  try {
    const factory = new ethers.Contract(CONFIG.V3_FACTORY, V3_FACTORY_ABI, provider);

    for (const pairedToken of pairedTokens) {
      for (const fee of feeTiers) {
        try {
          const poolAddress = await factory.getPool(tokenAddress, pairedToken, fee);
          if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            pools.push({
              address: poolAddress,
              fee,
              type: 'V3'
            });
            console.log(`   Found V3 pool (${fee/10000}% fee): ${poolAddress}`);
          }
        } catch (e) {
          // Pool doesn't exist
        }
      }
    }
  } catch (e) {
    console.log(`   V3 factory error: ${e.message}`);
  }

  return pools;
}

// ═══════════════════════════════════════════════════════════════════
// SWAP EVENT QUERIES
// ═══════════════════════════════════════════════════════════════════

// Note: We primarily use ERC-20 Transfer events (getTokenTransferSwaps) to catch
// ALL trading activity across V2, V3, V4, and aggregators. The V3 swap query
// below is kept for reference but not actively used.

/**
 * Get swap events by querying ERC-20 Transfer events on the token
 * This catches ALL swaps (V2, V3, V4, aggregators) involving the token
 * Much more reliable than querying individual pool contracts
 */
async function getTokenTransferSwaps(provider, tokenAddress, fromBlock, toBlock, targetWallets) {
  const swaps = [];

  try {
    console.log(`   Querying ${tokenAddress.slice(0,10)}... Transfer events (blocks ${fromBlock}-${toBlock})...`);

    const tokenContract = new ethers.Contract(tokenAddress, [
      'event Transfer(address indexed from, address indexed to, uint256 value)'
    ], provider);

    const walletLower = new Set(targetWallets.map(w => w.toLowerCase()));

    // Query Transfer events in chunks to avoid RPC limits
    const CHUNK_SIZE = 10000;
    let currentFrom = fromBlock;

    while (currentFrom < toBlock) {
      const currentTo = Math.min(currentFrom + CHUNK_SIZE, toBlock);

      try {
        const events = await withRetry(() => tokenContract.queryFilter(
          tokenContract.filters.Transfer(),
          currentFrom,
          currentTo
        ));

        for (const event of events) {
          const { from, to, value } = event.args;
          const fromLower = from.toLowerCase();
          const toLower = to.toLowerCase();

          // Check if either sender or recipient is one of our target wallets
          if (walletLower.has(fromLower)) {
            // Wallet sold/sent tokens
            swaps.push({
              wallet: fromLower,
              volume: value,
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              direction: 'out'
            });
          }
          if (walletLower.has(toLower)) {
            // Wallet bought/received tokens
            swaps.push({
              wallet: toLower,
              volume: value,
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              direction: 'in'
            });
          }
        }

        currentFrom = currentTo + 1;
      } catch (e) {
        console.log(`   Chunk ${currentFrom}-${currentTo} error: ${e.message?.slice(0, 50)}`);
        // Try smaller chunks
        currentFrom = currentTo + 1;
      }
    }

    console.log(`   Found ${swaps.length} token transfers involving target wallets`);
  } catch (e) {
    console.log(`   Token transfer query error: ${e.message?.slice(0, 80)}`);
  }

  return swaps;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN VOLUME CALCULATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate trading volume for a list of wallets
 *
 * Uses ERC-20 Transfer events to catch ALL trading activity (V2, V3, V4, aggregators)
 * This is more reliable than querying individual pool contracts.
 *
 * @param {string} tokenAddress - Token to check volume for
 * @param {string[]} walletAddresses - Wallets to check (from social qualification)
 * @param {number} minVolumeUSD - Minimum USD volume required
 * @param {number} startTimestamp - Contest start time (unix)
 * @param {number} endTimestamp - Contest end time (unix)
 * @returns {Object[]} Array of { address, volumeUSD, passed }
 */
async function getUniswapVolumes(tokenAddress, walletAddresses, minVolumeUSD, startTimestamp, endTimestamp) {
  console.log('\n📊 Checking trading volumes via token transfers...');
  console.log(`   Token: ${tokenAddress}`);
  console.log(`   Wallets to check: ${walletAddresses.length}`);
  console.log(`   Min volume required: $${minVolumeUSD}`);

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Convert timestamps to block numbers
  const fromBlock = await timestampToBlock(provider, startTimestamp);
  const toBlock = await timestampToBlock(provider, endTimestamp);

  console.log(`   Block range: ${fromBlock} - ${toBlock}`);

  // If no volume required, everyone passes (but still show volume info for logging)
  const skipVolumeCheck = minVolumeUSD === 0;

  // Get token decimals
  let tokenDecimals = 18;
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    tokenDecimals = Number(await tokenContract.decimals());
  } catch (e) {
    console.log('   Could not get token decimals, using 18');
  }

  // Try to get stored contest price first (captured at contest creation)
  // This prevents price manipulation during the contest
  let tokenPriceUSD = null;
  let priceSource = 'live';

  // Check if we have a contestId to look up stored price
  // Note: contestId should be passed via options in production
  try {
    if (process.env.KV_REST_API_URL && global._currentContestId) {
      const { kv } = require('@vercel/kv');
      const storedPrice = await kv.get(`contest_price_${global._currentContestId}`);
      if (storedPrice && storedPrice.tokenPrice) {
        tokenPriceUSD = storedPrice.tokenPrice;
        priceSource = `stored (from ${storedPrice.capturedAt})`;
        console.log(`   Using stored price from contest creation: $${tokenPriceUSD.toFixed(8)}`);
      }
    }
  } catch (e) {
    // Fall through to live price
  }

  // Fall back to current/live price if no stored price
  if (!tokenPriceUSD) {
    tokenPriceUSD = await getTokenPriceUSD(provider, tokenAddress);
    console.log(`   Token price (${priceSource}): $${tokenPriceUSD.toFixed(8)}`);
  }

  // Query token Transfer events for all target wallets
  // This catches ALL trading activity (V2, V3, V4, DEX aggregators, etc.)
  const transfers = await getTokenTransferSwaps(provider, tokenAddress, fromBlock, toBlock, walletAddresses);

  // Aggregate volume per wallet using HISTORICAL prices at time of each trade
  // This prevents gaming via price manipulation
  const volumeByWallet = new Map(); // wallet -> { volumeTokens, volumeUSD }

  console.log(`   Calculating historical USD values for ${transfers.length} transfers...`);

  for (const transfer of transfers) {
    const current = volumeByWallet.get(transfer.wallet) || { volumeTokens: 0n, volumeUSD: 0 };
    const volumeTokens = current.volumeTokens + transfer.volume;

    // Get historical price at the block when this transfer occurred
    let transferUSD = 0;
    try {
      const historicalPrice = await getHistoricalTokenPriceUSD(provider, tokenAddress, transfer.blockNumber);
      const transferTokens = Number(transfer.volume) / Math.pow(10, tokenDecimals);
      transferUSD = transferTokens * historicalPrice;
    } catch (e) {
      // Fall back to current price if historical fails
      const transferTokens = Number(transfer.volume) / Math.pow(10, tokenDecimals);
      transferUSD = transferTokens * tokenPriceUSD;
    }

    volumeByWallet.set(transfer.wallet, {
      volumeTokens,
      volumeUSD: current.volumeUSD + transferUSD
    });
  }

  // Calculate USD volumes and check against minimum
  const results = [];

  for (const address of walletAddresses) {
    const addrLower = address.toLowerCase();
    const walletData = volumeByWallet.get(addrLower) || { volumeTokens: 0n, volumeUSD: 0 };
    const volumeTokens = Number(walletData.volumeTokens) / Math.pow(10, tokenDecimals);
    const volumeUSD = walletData.volumeUSD;

    const passed = skipVolumeCheck ? true : volumeUSD >= minVolumeUSD;

    if (volumeUSD > 0) {
      console.log(`   ${addrLower.slice(0,10)}... volume: $${volumeUSD.toFixed(4)} (${volumeTokens.toFixed(2)} tokens, historical) ${passed ? '✅' : '❌'}`);
    }

    results.push({
      address: addrLower,
      volumeUSD,
      volumeTokens,
      passed
    });
  }

  const passedCount = results.filter(r => r.passed).length;
  console.log(`\n   Volume check: ${passedCount}/${walletAddresses.length} passed`);

  return results;
}

/**
 * Get historical token price at a specific block
 * Uses the V4 pool state at that block for accurate historical pricing
 */
async function getHistoricalTokenPriceUSD(provider, tokenAddress, blockNumber) {
  const ethPriceUSD = await getETHPrice(provider);

  // Use historical lookup for known V4 pool
  const knownV4Price = await tryKnownV4Pool(provider, tokenAddress, ethPriceUSD, { blockNumber });
  if (knownV4Price) {
    return knownV4Price;
  }

  // Fall back to current price if historical lookup fails
  return await getTokenPriceUSD(provider, tokenAddress);
}

/**
 * Get approximate token price in USD using ETH pair
 * Priority: Known V4 pools > V2 pools > V3 pools > V4 discovery
 */
async function getTokenPriceUSD(provider, tokenAddress) {
  // Get current ETH price from Chainlink
  const ethPriceUSD = await getETHPrice(provider);

  try {
    // First, check if we have a known V4 pool for this token (highest priority)
    const knownV4Price = await tryKnownV4Pool(provider, tokenAddress, ethPriceUSD);
    if (knownV4Price) {
      return knownV4Price;
    }

    // Try V2 pool (often more liquid for smaller tokens)
    for (const factoryAddress of CONFIG.V2_FACTORIES) {
      try {
        const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(tokenAddress, CONFIG.WETH);

        if (pairAddress && pairAddress !== ethers.ZeroAddress) {
          const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
          // Batch these two calls in parallel
          const [token0, reserves] = await Promise.all([
            withRetry(() => pair.token0()),
            withRetry(() => pair.getReserves())
          ]);

          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
          const tokenReserve = isToken0 ? reserves.reserve0 : reserves.reserve1;
          const ethReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;

          if (tokenReserve > 0n && ethReserve > 0n) {
            const tokenPriceInETH = Number(ethReserve) / Number(tokenReserve);
            console.log(`   V2 price: ${tokenPriceInETH.toFixed(12)} ETH ($${(tokenPriceInETH * ethPriceUSD).toFixed(8)})`);
            return tokenPriceInETH * ethPriceUSD;
          }
        }
      } catch (e) {
        // Continue to next factory
      }
    }

    // Try V3 pools (check all fee tiers)
    const feeTiers = [10000, 3000, 500]; // 1%, 0.3%, 0.05%

    for (const fee of feeTiers) {
      try {
        const v3Factory = new ethers.Contract(CONFIG.V3_FACTORY, V3_FACTORY_ABI, provider);
        const poolAddress = await v3Factory.getPool(tokenAddress, CONFIG.WETH, fee);

        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          const slot0ABI = [
            'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
            'function token0() view returns (address)'
          ];
          const pool = new ethers.Contract(poolAddress, slot0ABI, provider);

          const [slot0, token0] = await Promise.all([
            withRetry(() => pool.slot0()),
            withRetry(() => pool.token0())
          ]);

          const sqrtPriceX96 = slot0.sqrtPriceX96;

          // Calculate price from sqrtPriceX96
          // price = (sqrtPriceX96 / 2^96)^2
          const price = Number(sqrtPriceX96) / (2 ** 96);
          const priceSquared = price * price;

          // Determine if token is token0 or token1
          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();

          // V3 price is token1/token0
          // If our token is token0, price tells us how much token1 (WETH) per token0
          // If our token is token1, we need to invert
          let tokenPriceInETH;
          if (isToken0) {
            tokenPriceInETH = priceSquared;
          } else {
            tokenPriceInETH = 1 / priceSquared;
          }

          console.log(`   V3 (${fee/10000}%) price: ${tokenPriceInETH.toFixed(12)} ETH ($${(tokenPriceInETH * ethPriceUSD).toFixed(8)})`);
          return tokenPriceInETH * ethPriceUSD;
        }
      } catch (e) {
        // Continue to next fee tier
      }
    }

    // Try V4 pools (Clanker tokens)
    const v4Price = await tryV4PriceUSD(provider, tokenAddress, ethPriceUSD);
    if (v4Price) {
      return v4Price;
    }

    console.log('   Could not determine token price, using fallback');
    return 0.0001; // Fallback price

  } catch (e) {
    console.log(`   Price fetch error: ${e.message}`);
    return 0.0001;
  }
}

/**
 * Get current ETH price in USD
 * Uses Chainlink price feed with caching to reduce RPC calls
 */
async function getETHPrice(provider = null) {
  // Return cached price if still valid
  const now = Date.now();
  if (cachedETHPrice && (now - ethPriceCacheTime) < ETH_PRICE_CACHE_TTL) {
    return cachedETHPrice;
  }

  try {
    // Chainlink ETH/USD price feed on Base
    const CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
    const rpcProvider = provider || new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    const priceFeed = new ethers.Contract(
      CHAINLINK_ETH_USD,
      ['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'],
      rpcProvider
    );

    const roundData = await withRetry(() => priceFeed.latestRoundData());
    // Chainlink uses 8 decimals for USD pairs
    const price = Number(roundData.answer) / 1e8;

    // Cache the result
    cachedETHPrice = price;
    ethPriceCacheTime = now;

    console.log(`   ETH price (Chainlink): $${price.toFixed(2)}`);
    return price;
  } catch (e) {
    console.log(`   Could not fetch ETH price from Chainlink: ${e.message?.slice(0, 50)}`);
    return cachedETHPrice || 3500; // Use cached price or fallback
  }
}

/**
 * Convert timestamp to approximate block number
 * Base has ~2 second blocks
 */
async function timestampToBlock(provider, timestamp) {
  try {
    const currentBlock = await provider.getBlockNumber();
    const currentTime = Math.floor(Date.now() / 1000);
    const timeDiff = currentTime - timestamp;
    const blockDiff = Math.floor(timeDiff / 2); // ~2 sec per block on Base
    return Math.max(1, currentBlock - blockDiff);
  } catch (e) {
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  getUniswapVolumes,
  findV2Pools,
  findV3Pools,
  getTokenPriceUSD,
  getHistoricalTokenPriceUSD,
  getETHPrice,
  CONFIG,
  KNOWN_V4_POOLS
};
