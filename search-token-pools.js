#!/usr/bin/env node
/**
 * Token Pool Search Tool
 *
 * Searches for all liquidity pools for a given token across:
 * - Uniswap V2
 * - Aerodrome (V2-style)
 * - Uniswap V3
 * - Uniswap V4 (Clanker hooks + native)
 *
 * Usage:
 *   node search-token-pools.js <token_address>
 *   node search-token-pools.js 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed  # DEGEN
 */

const { ethers } = require('ethers');

// Load dotenv if available
try { require('dotenv').config({ path: '.env.local' }); } catch (e) {}

// Base RPC for reliable queries
const BASE_RPC_URL = 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/';

const CONFIG = {
  BASE_RPC: BASE_RPC_URL,
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',

  // V2 Factories
  V2_FACTORIES: [
    { address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', name: 'Uniswap V2' },
    { address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', name: 'Aerodrome' },
  ],

  // V3 Factory
  V3_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',

  // V4
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',

  // Chainlink ETH/USD
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
};

// ABIs
const V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];
const V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const V3_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'];
const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
];
const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
];

// PoolManager ABI for discovering pools via Initialize events
const POOL_MANAGER_ADDRESS = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)',
];

// Clanker API for looking up V4 pool data
const CLANKER_API_URL = 'https://www.clanker.world/api/tokens';
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

/**
 * Fetch token data from Clanker API
 * Returns pool_address (V4 pool ID) and hook_address if found
 *
 * Note: The Clanker API doesn't support direct address lookup, so we search
 * through paginated results. For tokens not in the API, we fall back to
 * the KNOWN_V4_POOLS registry.
 */
async function fetchClankerData(tokenAddress) {
  // First check our local registry of known pools
  const knownPool = {
    // NEYNARTODES - manually added since not in Clanker API
    '0x8de1622fe07f56cda2e2273e615a513f1d828b07': {
      poolId: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
      hookAddress: null, // Unknown, but we have the pool ID
      name: 'Dang NeynarTodes',
      symbol: 'NEYNARTODES',
    },
  };

  const local = knownPool[tokenAddress.toLowerCase()];
  if (local) {
    return {
      found: true,
      poolId: local.poolId,
      hookAddress: local.hookAddress,
      name: local.name,
      symbol: local.symbol,
      type: 'clanker_v4',
      pair: 'WETH',
      source: 'local-registry',
    };
  }

  // Try the Clanker API
  return new Promise((resolve) => {
    const https = require('https');
    const url = `${CLANKER_API_URL}?search=${tokenAddress.toLowerCase()}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data.length > 0) {
            // Find the token with matching contract_address
            const token = json.data.find(t =>
              t.contract_address?.toLowerCase() === tokenAddress.toLowerCase()
            );

            if (token && token.type === 'clanker_v4') {
              const poolId = token.pool_address || token.extensions?.poolExtension?.poolId;
              const hookAddress = token.extensions?.fees?.hook_address;

              resolve({
                found: true,
                poolId,
                hookAddress,
                name: token.name,
                symbol: token.symbol,
                type: token.type,
                pair: token.pair,
                source: 'clanker-api',
              });
            } else {
              resolve({ found: false });
            }
          } else {
            resolve({ found: false });
          }
        } catch (e) {
          resolve({ found: false, error: e.message });
        }
      });
    }).on('error', (e) => {
      resolve({ found: false, error: e.message });
    });
  });
}

// Helper to retry failed RPC calls
async function withRetry(fn, retries = 3, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

function computeV4PoolId(token0, token1, fee, tickSpacing, hooks) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [token0, token1, fee, tickSpacing, hooks]
  );
  return ethers.keccak256(encoded);
}

async function getETHPrice(provider) {
  try {
    const priceFeed = new ethers.Contract(
      CONFIG.CHAINLINK_ETH_USD,
      ['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'],
      provider
    );
    const roundData = await priceFeed.latestRoundData();
    return Number(roundData[1]) / 1e8;
  } catch (e) {
    return 3500;
  }
}

async function getTokenInfo(provider, tokenAddress) {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([
      token.symbol().catch(() => 'UNKNOWN'),
      token.decimals().catch(() => 18),
      token.name().catch(() => 'Unknown Token'),
    ]);
    return { symbol, decimals: Number(decimals), name };
  } catch (e) {
    return { symbol: 'UNKNOWN', decimals: 18, name: 'Unknown Token' };
  }
}

async function searchV2Pools(provider, tokenAddress, pairedTokens, ethPrice) {
  const pools = [];

  for (const factory of CONFIG.V2_FACTORIES) {
    for (const paired of pairedTokens) {
      try {
        const factoryContract = new ethers.Contract(factory.address, V2_FACTORY_ABI, provider);
        const pairAddress = await factoryContract.getPair(tokenAddress, paired.address);

        console.log(`      ${factory.name} ${paired.symbol}: ${pairAddress.slice(0, 10)}...`);

        if (pairAddress && pairAddress !== ethers.ZeroAddress) {
          const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);

          // Sequential calls with retry to handle RPC rate limits
          const token0 = await withRetry(() => pair.token0());
          const reserves = await withRetry(() => pair.getReserves());

          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
          const tokenReserve = isToken0 ? reserves.reserve0 : reserves.reserve1;
          const pairedReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;

          // Calculate price
          let priceUSD = 0;
          if (tokenReserve > 0n && pairedReserve > 0n) {
            const priceInPaired = Number(pairedReserve) / Number(tokenReserve);
            if (paired.symbol === 'WETH') {
              priceUSD = priceInPaired * ethPrice;
            } else if (paired.symbol === 'USDC') {
              priceUSD = priceInPaired / 1e12; // USDC has 6 decimals, tokens typically 18
            }
          }

          // Calculate TVL
          let tvlUSD = 0;
          if (paired.symbol === 'WETH') {
            tvlUSD = (Number(pairedReserve) / 1e18) * ethPrice * 2;
          } else if (paired.symbol === 'USDC') {
            tvlUSD = (Number(pairedReserve) / 1e6) * 2;
          }

          pools.push({
            type: 'V2',
            dex: factory.name,
            address: pairAddress,
            pairedWith: paired.symbol,
            tokenReserve: Number(tokenReserve),
            pairedReserve: Number(pairedReserve),
            priceUSD,
            tvlUSD,
          });
        }
      } catch (e) {
        console.log(`      Error: ${e.message.slice(0, 80)}`);
      }
    }
  }

  return pools;
}

async function searchV3Pools(provider, tokenAddress, pairedTokens, ethPrice) {
  const pools = [];
  const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

  const factory = new ethers.Contract(CONFIG.V3_FACTORY, V3_FACTORY_ABI, provider);

  for (const paired of pairedTokens) {
    for (const fee of feeTiers) {
      try {
        const poolAddress = await factory.getPool(tokenAddress, paired.address, fee);

        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
          const [token0, slot0, liquidity] = await Promise.all([
            pool.token0(),
            pool.slot0(),
            pool.liquidity(),
          ]);

          const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
          const sqrtPriceX96 = slot0.sqrtPriceX96;

          // Calculate price
          const price = Number(sqrtPriceX96) / (2 ** 96);
          const priceSquared = price * price;

          let priceInPaired;
          if (isToken0) {
            priceInPaired = priceSquared;
          } else {
            priceInPaired = 1 / priceSquared;
          }

          let priceUSD = 0;
          if (paired.symbol === 'WETH') {
            priceUSD = priceInPaired * ethPrice;
          } else if (paired.symbol === 'USDC') {
            priceUSD = priceInPaired / 1e12;
          }

          pools.push({
            type: 'V3',
            dex: 'Uniswap V3',
            address: poolAddress,
            fee: fee / 10000 + '%',
            pairedWith: paired.symbol,
            liquidity: liquidity.toString(),
            priceUSD,
            tick: Number(slot0.tick),
          });
        }
      } catch (e) {
        // Skip
      }
    }
  }

  return pools;
}

/**
 * Discover V4 pools by querying Initialize events from PoolManager
 * This finds ANY V4 pool for the token, regardless of hook address
 */
async function discoverV4Pools(provider, tokenAddress, ethPrice) {
  const pools = [];
  const tokenLower = tokenAddress.toLowerCase();
  const wethLower = CONFIG.WETH.toLowerCase();

  const poolManager = new ethers.Contract(POOL_MANAGER_ADDRESS, POOL_MANAGER_ABI, provider);
  const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  // Sort addresses to determine which is currency0/currency1
  const [currency0, currency1] = tokenLower < wethLower
    ? [tokenAddress, CONFIG.WETH]
    : [CONFIG.WETH, tokenAddress];

  const isToken0 = tokenLower === currency0.toLowerCase();

  try {
    // Query Initialize events where this token is either currency0 or currency1
    // We need to do two separate queries since we can only filter on indexed params
    const filter0 = poolManager.filters.Initialize(null, currency0, null);
    const filter1 = poolManager.filters.Initialize(null, null, currency1);

    // Get events from a reasonable block range (Base launched ~June 2023)
    // V4 pools are newer, so we can use a more recent block
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000000); // ~6 months of blocks

    console.log(`    Querying Initialize events from block ${fromBlock}...`);

    const [events0, events1] = await Promise.all([
      poolManager.queryFilter(filter0, fromBlock, 'latest').catch(() => []),
      poolManager.queryFilter(filter1, fromBlock, 'latest').catch(() => []),
    ]);

    // Combine and deduplicate events
    const allEvents = [...events0, ...events1];
    const seenPoolIds = new Set();

    console.log(`    Found ${allEvents.length} Initialize events`);

    for (const event of allEvents) {
      try {
        const { id: poolId, currency0: c0, currency1: c1, fee, tickSpacing, hooks } = event.args;

        // Skip if we've seen this pool
        if (seenPoolIds.has(poolId)) continue;
        seenPoolIds.add(poolId);

        // Check if this pool involves our token AND WETH
        const c0Lower = c0.toLowerCase();
        const c1Lower = c1.toLowerCase();
        const involvesToken = c0Lower === tokenLower || c1Lower === tokenLower;
        const involvesWeth = c0Lower === wethLower || c1Lower === wethLower;

        if (!involvesToken || !involvesWeth) continue;

        // Get pool state
        const [slot0, liquidity] = await Promise.all([
          stateView.getSlot0(poolId),
          stateView.getLiquidity(poolId).catch(() => 0n),
        ]);

        if (slot0.sqrtPriceX96 === 0n) continue;

        // Calculate price
        const sqrtPriceX96 = slot0.sqrtPriceX96;
        const price = Number(sqrtPriceX96) / (2 ** 96);
        const priceSquared = price * price;

        // Determine if our token is currency0 in THIS pool
        const tokenIsCurrency0 = c0Lower === tokenLower;
        let priceInETH;
        if (tokenIsCurrency0) {
          priceInETH = priceSquared;
        } else {
          priceInETH = 1 / priceSquared;
        }

        const priceUSD = priceInETH * ethPrice;

        // Identify the hook
        let hookName = 'Unknown';
        const hooksLower = hooks.toLowerCase();
        if (hooksLower === '0x0000000000000000000000000000000000000000') {
          hookName = 'Native';
        } else if (hooksLower === '0x1ed8c4907aef90aa7506eb553af519b8a4545772') {
          hookName = 'Clanker V1';
        } else {
          hookName = `Hook:${hooks.slice(0, 10)}...`;
        }

        pools.push({
          type: 'V4',
          dex: 'Uniswap V4',
          hook: hookName,
          hookAddress: hooks,
          fee: Number(fee) / 10000 + '%',
          tickSpacing: Number(tickSpacing),
          pairedWith: 'WETH',
          poolId: poolId,
          fullPoolId: poolId,
          liquidity: liquidity.toString(),
          priceUSD,
          priceInETH,
          tick: Number(slot0.tick),
        });
      } catch (e) {
        // Skip this event
      }
    }
  } catch (e) {
    console.log(`    Event query error: ${e.message.slice(0, 80)}`);
  }

  return pools;
}

/**
 * Search V4 pools using both known hooks AND event discovery
 */
async function searchV4Pools(provider, tokenAddress, pairedTokens, ethPrice) {
  const pools = [];

  // Known hooks to check directly (faster than event scanning)
  // From Clanker docs: ClankerHook, ClankerHookStaticFee, ClankerHookDynamicFee, V2 variants
  const HOOKS = [
    { address: '0x0000000000000000000000000000000000000000', name: 'Native' },
    { address: '0x1eD8c4907aEF90aA7506eB553af519b8a4545772', name: 'Clanker V1' },
    { address: '0x7F3e89d36e9a171eFd7e098E0F28F93d440dEE74', name: 'Clanker V2' },
    { address: '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC', name: 'Clanker Current' }, // From Clanker API
  ];

  const V4_CONFIGS = [
    { fee: 100, tickSpacing: 1 },
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 },
  ];

  const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);
  const foundPoolIds = new Set();

  // First, try known hooks (fast path)
  for (const paired of pairedTokens) {
    const [currency0, currency1] = tokenAddress.toLowerCase() < paired.address.toLowerCase()
      ? [tokenAddress, paired.address]
      : [paired.address, tokenAddress];

    const isToken0 = tokenAddress.toLowerCase() === currency0.toLowerCase();

    for (const hook of HOOKS) {
      for (const config of V4_CONFIGS) {
        try {
          const poolId = computeV4PoolId(currency0, currency1, config.fee, config.tickSpacing, hook.address);

          // Skip if already found via events
          if (foundPoolIds.has(poolId)) continue;

          const [slot0, liquidity] = await Promise.all([
            stateView.getSlot0(poolId),
            stateView.getLiquidity(poolId).catch(() => 0n),
          ]);

          if (slot0.sqrtPriceX96 > 0n) {
            foundPoolIds.add(poolId);

            const sqrtPriceX96 = slot0.sqrtPriceX96;
            const price = Number(sqrtPriceX96) / (2 ** 96);
            const priceSquared = price * price;

            let priceInPaired;
            if (isToken0) {
              priceInPaired = priceSquared;
            } else {
              priceInPaired = 1 / priceSquared;
            }

            let priceUSD = 0;
            if (paired.symbol === 'WETH') {
              priceUSD = priceInPaired * ethPrice;
            } else if (paired.symbol === 'USDC') {
              priceUSD = priceInPaired / 1e12;
            }

            pools.push({
              type: 'V4',
              dex: 'Uniswap V4',
              hook: hook.name,
              hookAddress: hook.address,
              fee: config.fee / 10000 + '%',
              tickSpacing: config.tickSpacing,
              pairedWith: paired.symbol,
              poolId: poolId.slice(0, 18) + '...',
              fullPoolId: poolId,
              liquidity: liquidity.toString(),
              priceUSD,
              tick: Number(slot0.tick),
            });
          }
        } catch (e) {
          // Skip
        }
      }
    }
  }

  // If no pools found via known hooks, try Clanker API then event discovery
  if (pools.length === 0) {
    console.log('    No pools found with known hooks, trying Clanker API...');

    const clankerData = await fetchClankerData(tokenAddress);
    if (clankerData.found && clankerData.poolId) {
      console.log(`    Found in Clanker API: ${clankerData.name} (${clankerData.symbol})`);
      console.log(`    Pool ID: ${clankerData.poolId}`);
      if (clankerData.hookAddress) {
        console.log(`    Hook: ${clankerData.hookAddress}`);
      }

      // Query the pool directly
      try {
        const [slot0, liquidity] = await Promise.all([
          stateView.getSlot0(clankerData.poolId),
          stateView.getLiquidity(clankerData.poolId).catch(() => 0n),
        ]);

        if (slot0.sqrtPriceX96 > 0n) {
          // Determine token ordering
          const tokenLower = tokenAddress.toLowerCase();
          const wethLower = CONFIG.WETH.toLowerCase();
          const isToken0 = tokenLower < wethLower;

          const sqrtPriceX96 = slot0.sqrtPriceX96;
          const price = Number(sqrtPriceX96) / (2 ** 96);
          const priceSquared = price * price;

          let priceInETH;
          if (isToken0) {
            priceInETH = priceSquared;
          } else {
            priceInETH = 1 / priceSquared;
          }

          const priceUSD = priceInETH * ethPrice;

          pools.push({
            type: 'V4',
            dex: 'Uniswap V4 (Clanker)',
            hook: clankerData.hookAddress ? `Hook:${clankerData.hookAddress.slice(0, 10)}...` : 'Unknown',
            hookAddress: clankerData.hookAddress || 'Unknown',
            fee: Number(slot0.lpFee) / 10000 + '%',
            tickSpacing: 'Clanker',
            pairedWith: 'WETH',
            poolId: clankerData.poolId.slice(0, 18) + '...',
            fullPoolId: clankerData.poolId,
            liquidity: liquidity.toString(),
            priceUSD,
            priceInETH,
            tick: Number(slot0.tick),
            source: 'clanker-api',
          });
        }
      } catch (e) {
        console.log(`    Error querying Clanker pool: ${e.message?.slice(0, 50)}`);
      }
    }

    // If still no pools, try event discovery (limited by RPC tier)
    if (pools.length === 0) {
      console.log('    Trying event discovery (may be limited by RPC tier)...');
      const discoveredPools = await discoverV4Pools(provider, tokenAddress, ethPrice);
      pools.push(...discoveredPools);
    }
  }

  return pools;
}

/**
 * Query a V4 pool directly by its pool ID
 * This is useful when you already know the pool ID (e.g., from Clanker)
 */
async function queryV4PoolById(provider, poolId, tokenAddress, ethPrice) {
  const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  try {
    const [slot0, liquidity] = await Promise.all([
      stateView.getSlot0(poolId),
      stateView.getLiquidity(poolId).catch(() => 0n),
    ]);

    if (slot0.sqrtPriceX96 === 0n) {
      console.log('Pool not found or has no liquidity');
      return null;
    }

    // Calculate price - we need to know token ordering to interpret sqrtPriceX96
    // Since we don't know the exact currencies from just the poolId, we'll
    // query the PoolManager Initialize event
    const poolManager = new ethers.Contract(POOL_MANAGER_ADDRESS, POOL_MANAGER_ABI, provider);
    const filter = poolManager.filters.Initialize(poolId);

    const currentBlock = await provider.getBlockNumber();
    const events = await poolManager.queryFilter(filter, currentBlock - 5000000, 'latest').catch(() => []);

    let currency0, currency1, fee, tickSpacing, hooks;
    if (events.length > 0) {
      const event = events[0];
      currency0 = event.args.currency0;
      currency1 = event.args.currency1;
      fee = Number(event.args.fee);
      tickSpacing = Number(event.args.tickSpacing);
      hooks = event.args.hooks;
    } else {
      console.log('Could not find pool initialization event');
      // Still return basic price data
      const sqrtPriceX96 = slot0.sqrtPriceX96;
      const price = Number(sqrtPriceX96) / (2 ** 96);
      const priceSquared = price * price;

      return {
        type: 'V4',
        poolId,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick: Number(slot0.tick),
        liquidity: liquidity.toString(),
        priceRaw: priceSquared,
        note: 'Price interpretation requires knowing token order',
      };
    }

    const tokenLower = tokenAddress.toLowerCase();
    const tokenIsCurrency0 = currency0.toLowerCase() === tokenLower;

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;

    let priceInETH;
    if (tokenIsCurrency0) {
      priceInETH = priceSquared;
    } else {
      priceInETH = 1 / priceSquared;
    }

    const priceUSD = priceInETH * ethPrice;

    // Identify hook
    let hookName = 'Unknown';
    const hooksLower = hooks.toLowerCase();
    if (hooksLower === '0x0000000000000000000000000000000000000000') {
      hookName = 'Native';
    } else if (hooksLower === '0x1ed8c4907aef90aa7506eb553af519b8a4545772') {
      hookName = 'Clanker V1';
    } else {
      hookName = `Hook:${hooks.slice(0, 10)}...`;
    }

    return {
      type: 'V4',
      dex: 'Uniswap V4',
      hook: hookName,
      hookAddress: hooks,
      fee: fee / 10000 + '%',
      tickSpacing,
      currency0,
      currency1,
      poolId,
      liquidity: liquidity.toString(),
      priceUSD,
      priceInETH,
      tick: Number(slot0.tick),
    };
  } catch (e) {
    console.log(`Error querying pool: ${e.message}`);
    return null;
  }
}

async function main() {
  const arg = process.argv[2];
  const poolIdArg = process.argv[3]; // Optional pool ID

  if (!arg) {
    console.log('Usage: node search-token-pools.js <token_address> [pool_id]');
    console.log('');
    console.log('Examples:');
    console.log('  node search-token-pools.js 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed  # DEGEN');
    console.log('  node search-token-pools.js 0x8de1622fe07f56cda2e2273e615a513f1d828b07  # NEYNARTODES');
    console.log('');
    console.log('  # Query specific V4 pool by ID:');
    console.log('  node search-token-pools.js 0x8de1622fe07f56cda2e2273e615a513f1d828b07 0xfad8f807...');
    process.exit(1);
  }

  const tokenAddress = arg;

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔍 TOKEN POOL SEARCH');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('');

  // Get token info
  const tokenInfo = await getTokenInfo(provider, tokenAddress);
  console.log(`Token: ${tokenInfo.name} (${tokenInfo.symbol})`);
  console.log(`Address: ${tokenAddress}`);
  console.log(`Decimals: ${tokenInfo.decimals}`);
  console.log('');

  // Get ETH price
  const ethPrice = await getETHPrice(provider);
  console.log(`ETH Price: $${ethPrice.toFixed(2)}`);
  console.log('');

  // If a pool ID was provided, query that specific pool
  if (poolIdArg) {
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ DIRECT V4 POOL QUERY                                            │');
    console.log('└─────────────────────────────────────────────────────────────────┘');
    console.log(`  Pool ID: ${poolIdArg}`);
    console.log('');

    const poolData = await queryV4PoolById(provider, poolIdArg, tokenAddress, ethPrice);
    if (poolData) {
      console.log(`  Type: ${poolData.type}`);
      console.log(`  DEX: ${poolData.dex || 'Uniswap V4'}`);
      console.log(`  Hook: ${poolData.hook || 'Unknown'}`);
      if (poolData.hookAddress) {
        console.log(`  Hook Address: ${poolData.hookAddress}`);
      }
      console.log(`  Fee: ${poolData.fee || 'Unknown'}`);
      console.log(`  Tick Spacing: ${poolData.tickSpacing || 'Unknown'}`);
      if (poolData.currency0) {
        console.log(`  Currency0: ${poolData.currency0}`);
        console.log(`  Currency1: ${poolData.currency1}`);
      }
      console.log(`  Current Tick: ${poolData.tick}`);
      console.log(`  Liquidity: ${poolData.liquidity}`);
      if (poolData.priceUSD) {
        console.log(`  Price (USD): $${poolData.priceUSD.toFixed(10)}`);
        console.log(`  Price (ETH): ${poolData.priceInETH.toFixed(18)} ETH`);
      } else if (poolData.priceRaw) {
        console.log(`  Price (raw): ${poolData.priceRaw}`);
        console.log(`  Note: ${poolData.note}`);
      }
    } else {
      console.log('  ❌ Could not query pool');
    }
    console.log('');
    return;
  }

  // Paired tokens to check
  const pairedTokens = [
    { address: CONFIG.WETH, symbol: 'WETH' },
    { address: CONFIG.USDC, symbol: 'USDC' },
  ];

  // Search all pool types
  console.log('Searching pools...');
  console.log('');

  // Search each pool type with error handling
  let v2Pools = [];
  let v3Pools = [];
  let v4Pools = [];

  try {
    console.log('  Checking V2 pools...');
    v2Pools = await searchV2Pools(provider, tokenAddress, pairedTokens, ethPrice);
    console.log(`    Found ${v2Pools.length} V2 pools`);
  } catch (e) {
    console.log('    V2 search error:', e.message.slice(0, 50));
  }

  try {
    console.log('  Checking V3 pools...');
    v3Pools = await searchV3Pools(provider, tokenAddress, pairedTokens, ethPrice);
    console.log(`    Found ${v3Pools.length} V3 pools`);
  } catch (e) {
    console.log('    V3 search error:', e.message.slice(0, 50));
  }

  try {
    console.log('  Checking V4 pools...');
    v4Pools = await searchV4Pools(provider, tokenAddress, pairedTokens, ethPrice);
    console.log(`    Found ${v4Pools.length} V4 pools`);
  } catch (e) {
    console.log('    V4 search error:', e.message.slice(0, 50));
  }

  console.log('');

  const allPools = [...v2Pools, ...v3Pools, ...v4Pools];

  if (allPools.length === 0) {
    console.log('❌ No pools found for this token');
    return;
  }

  // Display V2 pools
  if (v2Pools.length > 0) {
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ V2 POOLS (Uniswap V2 + Aerodrome)                               │');
    console.log('└─────────────────────────────────────────────────────────────────┘');
    for (const pool of v2Pools) {
      console.log(`  📊 ${pool.dex} - ${tokenInfo.symbol}/${pool.pairedWith}`);
      console.log(`     Address: ${pool.address}`);
      console.log(`     Price: $${pool.priceUSD.toFixed(8)}`);
      console.log(`     TVL: $${pool.tvlUSD.toFixed(2)}`);
      console.log('');
    }
  }

  // Display V3 pools
  if (v3Pools.length > 0) {
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ V3 POOLS (Uniswap V3)                                           │');
    console.log('└─────────────────────────────────────────────────────────────────┘');
    for (const pool of v3Pools) {
      console.log(`  📊 ${pool.dex} (${pool.fee}) - ${tokenInfo.symbol}/${pool.pairedWith}`);
      console.log(`     Address: ${pool.address}`);
      console.log(`     Price: $${pool.priceUSD.toFixed(8)}`);
      console.log(`     Tick: ${pool.tick}`);
      console.log('');
    }
  }

  // Display V4 pools
  if (v4Pools.length > 0) {
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ V4 POOLS (Uniswap V4 / Clanker)                                 │');
    console.log('└─────────────────────────────────────────────────────────────────┘');
    for (const pool of v4Pools) {
      console.log(`  📊 ${pool.dex} (${pool.hook}, ${pool.fee}) - ${tokenInfo.symbol}/${pool.pairedWith}`);
      console.log(`     Pool ID: ${pool.poolId}`);
      console.log(`     Price: $${pool.priceUSD.toFixed(8)}`);
      console.log(`     Tick: ${pool.tick}`);
      console.log('');
    }
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('📋 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Total Pools Found: ${allPools.length}`);
  console.log(`    - V2 pools: ${v2Pools.length}`);
  console.log(`    - V3 pools: ${v3Pools.length}`);
  console.log(`    - V4 pools: ${v4Pools.length}`);
  console.log('');

  // Best price (from pool with most liquidity/TVL)
  const prices = allPools.filter(p => p.priceUSD > 0).map(p => p.priceUSD);
  if (prices.length > 0) {
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    console.log(`  Price Range: $${minPrice.toFixed(8)} - $${maxPrice.toFixed(8)}`);
    console.log(`  Average Price: $${avgPrice.toFixed(8)}`);
  }
  console.log('');
}

main().catch(console.error);
