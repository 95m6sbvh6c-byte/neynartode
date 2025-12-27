#!/usr/bin/env node
/**
 * Check User Status
 *
 * Looks up a Farcaster user and checks their NEYNARTODES trading activity,
 * token holdings, and contest eligibility.
 *
 * Usage:
 *   node check-user.js @username
 *   node check-user.js username
 *   node check-user.js 0xWalletAddress
 */

const { ethers } = require('ethers');

const CONFIG = {
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',
  WETH: '0x4200000000000000000000000000000000000006',
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  BLOCKSCOUT_API: 'https://base.blockscout.com/api/v2',
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
  'function nextContestId() external view returns (uint256)',
];

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

// Price cache for historical lookups (block -> price)
const priceCache = new Map();

/**
 * Get ETH price in USD from Chainlink (current price)
 */
async function getETHPriceUSD(provider) {
  try {
    const priceFeed = new ethers.Contract(CONFIG.CHAINLINK_ETH_USD, CHAINLINK_ABI, provider);
    const roundData = await priceFeed.latestRoundData();
    return Number(roundData.answer) / 1e8;
  } catch (e) {
    console.log('   Could not fetch ETH price, using fallback');
    return 3500;
  }
}

/**
 * Get NEYNARTODES price in USD using V4 pool (current price)
 */
async function getTokenPriceUSD(provider) {
  try {
    const ethPriceUSD = await getETHPriceUSD(provider);
    const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

    const slot0 = await stateView.getSlot0(CONFIG.NEYNARTODES_POOL_ID);

    if (slot0.sqrtPriceX96 === 0n) {
      console.log('   Pool has no liquidity');
      return 0;
    }

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;

    // NEYNARTODES is currency1 (token1), WETH is currency0
    // sqrtPrice gives us token1/token0 = NEYNARTODES/WETH
    // We need WETH/NEYNARTODES, so invert
    const priceInETH = 1 / priceSquared;
    const priceInUSD = priceInETH * ethPriceUSD;

    return priceInUSD;
  } catch (e) {
    console.log('   Could not fetch token price:', e.message?.slice(0, 50));
    return 0;
  }
}

/**
 * Get historical NEYNARTODES price at a specific block
 * Uses eth_call with block override to get pool state at that block
 */
async function getHistoricalTokenPriceUSD(provider, blockNumber) {
  // Check cache first
  const cacheKey = `${blockNumber}`;
  if (priceCache.has(cacheKey)) {
    return priceCache.get(cacheKey);
  }

  try {
    // Get ETH price (use current - Chainlink historical requires archive node)
    // ETH price doesn't swing as dramatically as meme tokens
    const ethPriceUSD = await getETHPriceUSD(provider);

    const stateView = new ethers.Contract(CONFIG.V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

    // Query pool state at historical block
    const slot0 = await stateView.getSlot0(CONFIG.NEYNARTODES_POOL_ID, { blockTag: blockNumber });

    if (slot0.sqrtPriceX96 === 0n) {
      return 0;
    }

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = Number(sqrtPriceX96) / (2 ** 96);
    const priceSquared = price * price;

    // NEYNARTODES is currency1 (token1), WETH is currency0
    const priceInETH = 1 / priceSquared;
    const priceInUSD = priceInETH * ethPriceUSD;

    // Cache the result
    priceCache.set(cacheKey, priceInUSD);

    return priceInUSD;
  } catch (e) {
    // If historical query fails, fall back to current price
    console.log(`   Historical price at block ${blockNumber} unavailable, using current`);
    const currentPrice = await getTokenPriceUSD(provider);
    priceCache.set(cacheKey, currentPrice);
    return currentPrice;
  }
}

/**
 * Get Farcaster user by username
 */
async function getUserByUsername(username) {
  const cleanUsername = username.replace(/^@/, '');

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/by_username?username=${cleanUsername}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) {
      console.error(`❌ User @${cleanUsername} not found on Farcaster`);
      return null;
    }

    const data = await response.json();
    return data.user;
  } catch (e) {
    console.error('Error fetching user:', e.message);
    return null;
  }
}

/**
 * Get Farcaster user by wallet address
 */
async function getUserByWallet(walletAddress) {
  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress.toLowerCase()}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    const users = data[walletAddress.toLowerCase()];
    return users && users.length > 0 ? users[0] : null;
  } catch (e) {
    return null;
  }
}

/**
 * Get NEYNARTODES balance for an address
 */
async function getTokenBalance(provider, address) {
  const token = new ethers.Contract(CONFIG.NEYNARTODES, ERC20_ABI, provider);
  const balance = await token.balanceOf(address);
  return Number(balance) / 1e18;
}

/**
 * Get recent NEYNARTODES transfers for addresses using direct blockchain queries
 * More reliable than Blockscout API
 */
async function getRecentTransfers(provider, addresses, fromBlock = null) {
  const transfers = [];
  const normalizedAddresses = addresses.map(a => a.toLowerCase());

  try {
    const tokenContract = new ethers.Contract(
      CONFIG.NEYNARTODES,
      ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      provider
    );

    // If no fromBlock specified, get last 24 hours (~43200 blocks on Base at 2s/block)
    const currentBlock = await provider.getBlockNumber();
    const startBlock = fromBlock || currentBlock - 43200;

    console.log(`   Scanning blocks ${startBlock} to ${currentBlock}...`);

    // Query transfers FROM these addresses (sells)
    for (const addr of normalizedAddresses) {
      const sellEvents = await tokenContract.queryFilter(
        tokenContract.filters.Transfer(addr, null),
        startBlock,
        currentBlock
      );

      for (const event of sellEvents) {
        const block = await event.getBlock();
        transfers.push({
          type: 'SELL',
          amount: Number(ethers.formatEther(event.args.value)),
          from: event.args.from.toLowerCase(),
          to: event.args.to.toLowerCase(),
          timestamp: block.timestamp * 1000,
          timestampStr: new Date(block.timestamp * 1000).toLocaleString(),
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
        });
      }

      // Query transfers TO these addresses (buys)
      const buyEvents = await tokenContract.queryFilter(
        tokenContract.filters.Transfer(null, addr),
        startBlock,
        currentBlock
      );

      for (const event of buyEvents) {
        const block = await event.getBlock();
        transfers.push({
          type: 'BUY',
          amount: Number(ethers.formatEther(event.args.value)),
          from: event.args.from.toLowerCase(),
          to: event.args.to.toLowerCase(),
          timestamp: block.timestamp * 1000,
          timestampStr: new Date(block.timestamp * 1000).toLocaleString(),
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
        });
      }
    }

    // Sort by timestamp descending
    transfers.sort((a, b) => b.timestamp - a.timestamp);

  } catch (e) {
    console.error('Error fetching transfers:', e.message);
  }

  return transfers;
}

/**
 * Calculate volume during a specific time period using historical prices
 * Returns both token volume and USD volume (calculated at time of each trade)
 */
async function calculateVolumeDuringPeriod(provider, transfers, startTime, endTime) {
  let volumeTokens = 0;
  let volumeUSD = 0;

  for (const tx of transfers) {
    const txTime = tx.timestamp / 1000; // Convert to seconds
    if (txTime >= startTime && txTime <= endTime) {
      volumeTokens += tx.amount;

      // Get historical price at transaction block
      if (tx.blockNumber) {
        const historicalPrice = await getHistoricalTokenPriceUSD(provider, tx.blockNumber);
        volumeUSD += tx.amount * historicalPrice;
      }
    }
  }

  return { volumeTokens, volumeUSD };
}

/**
 * Get transfers for a specific contest period (faster, no block timestamp lookups)
 */
async function getContestPeriodTransfers(provider, addresses, fromBlock, toBlock) {
  const transfers = [];
  const normalizedAddresses = addresses.map(a => a.toLowerCase());

  try {
    const tokenContract = new ethers.Contract(
      CONFIG.NEYNARTODES,
      ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      provider
    );

    for (const addr of normalizedAddresses) {
      // Sells
      const sellEvents = await tokenContract.queryFilter(
        tokenContract.filters.Transfer(addr, null),
        fromBlock,
        toBlock
      );

      for (const event of sellEvents) {
        const block = await event.getBlock();
        transfers.push({
          type: 'SELL',
          amount: Number(ethers.formatEther(event.args.value)),
          from: event.args.from.toLowerCase(),
          to: event.args.to.toLowerCase(),
          timestamp: block.timestamp * 1000,
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
          type: 'BUY',
          amount: Number(ethers.formatEther(event.args.value)),
          from: event.args.from.toLowerCase(),
          to: event.args.to.toLowerCase(),
          timestamp: block.timestamp * 1000,
          blockNumber: event.blockNumber,
        });
      }
    }
  } catch (e) {
    // Silently fail - will return empty array
  }

  return transfers;
}

/**
 * Get active contests and check if user qualifies
 * Uses historical prices for accurate USD volume calculation
 */
async function checkContestEligibility(provider, addresses) {
  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
  const results = [];

  try {
    const nextId = await contract.nextContestId();
    const totalContests = Number(nextId) - 1;
    const now = Math.floor(Date.now() / 1000);
    const currentBlock = await provider.getBlockNumber();

    for (let i = totalContests; i >= Math.max(1, totalContests - 10); i--) {
      try {
        const contest = await contract.getContest(i);
        const [, , prizeAmount, startTime, endTime, castId, , volumeReq, status] = contest;

        const contestStartTime = Number(startTime);
        const contestEndTime = Number(endTime);
        const contestStatus = Number(status);

        // Only check active contests
        if (contestStatus === 0 && contestEndTime > now) {
          // Calculate block range for contest period
          // Base has ~2 second blocks
          const elapsedTime = now - contestStartTime;
          const blocksElapsed = Math.floor(elapsedTime / 2);
          const fromBlock = currentBlock - blocksElapsed;

          // Get transfers specifically for this contest period
          const contestTransfers = await getContestPeriodTransfers(
            provider, addresses, fromBlock, currentBlock
          );

          // Calculate user's volume during contest period with HISTORICAL prices
          const { volumeTokens, volumeUSD } = await calculateVolumeDuringPeriod(
            provider, contestTransfers, contestStartTime, contestEndTime
          );
          const volumeRequiredUSD = Number(volumeReq) / 1e18;

          // Check if volume requirement is met
          const volumeMet = volumeUSD >= volumeRequiredUSD;

          // Parse requirements from castId
          let requireRecast = false, requireLike = false, requireReply = false;
          if (castId.includes('|')) {
            const reqCode = castId.split('|')[1];
            if (reqCode) {
              const recastMatch = reqCode.match(/R(\d)/);
              const likeMatch = reqCode.match(/L(\d)/);
              const replyMatch = reqCode.match(/P(\d)/);
              if (recastMatch) requireRecast = recastMatch[1] !== '0';
              if (likeMatch) requireLike = likeMatch[1] !== '0';
              if (replyMatch) requireReply = replyMatch[1] !== '0';
            }
          }

          const timeLeft = contestEndTime - now;
          const hoursLeft = Math.floor(timeLeft / 3600);
          const minsLeft = Math.floor((timeLeft % 3600) / 60);

          results.push({
            contestId: i,
            volumeMet,
            volumeTokens,
            volumeUSD,
            volumeRequiredUSD,
            timeLeft: `${hoursLeft}h ${minsLeft}m`,
            requirements: {
              recast: requireRecast,
              like: requireLike,
              reply: requireReply,
            },
            prizeAmount: Number(prizeAmount) / 1e18,
            contestStartTime,
            contestEndTime,
          });
        }
      } catch (e) {
        // Skip failed contests
      }
    }
  } catch (e) {
    console.error('Error checking contests:', e.message);
  }

  return results;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
📊 Check User Status

Usage:
  node check-user.js @username
  node check-user.js username
  node check-user.js 0xWalletAddress

Examples:
  node check-user.js @bedebah
  node check-user.js brianwharton
  node check-user.js 0xe6ff471f3a96a718e44a3ccd4c956d518a8b11e5
`);
    process.exit(0);
  }

  const input = args[0];
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  console.log('\n🔍 Looking up user...\n');

  let user;
  let addresses = [];

  // Check if input is a wallet address or username
  if (input.startsWith('0x') && input.length === 42) {
    user = await getUserByWallet(input);
    addresses = [input];
    if (user) {
      if (user.verified_addresses?.eth_addresses) {
        addresses = [...new Set([input, ...user.verified_addresses.eth_addresses])];
      }
    }
  } else {
    user = await getUserByUsername(input);
    if (user) {
      addresses = [user.custody_address];
      if (user.verified_addresses?.eth_addresses) {
        addresses = [...addresses, ...user.verified_addresses.eth_addresses];
      }
    }
  }

  if (!user && addresses.length === 0) {
    console.log('❌ Could not find user or wallet');
    process.exit(1);
  }

  // Get token price
  console.log('💵 Fetching token price...');
  const tokenPriceUSD = await getTokenPriceUSD(provider);
  console.log(`   NEYNARTODES: $${tokenPriceUSD.toFixed(10)}`);

  // Print user info
  console.log('\n' + '═'.repeat(50));
  if (user) {
    console.log(`👤 User: @${user.username} (FID: ${user.fid})`);
    console.log(`   Display: ${user.display_name || 'N/A'}`);
    console.log(`   Followers: ${user.follower_count || 0}`);
  } else {
    console.log(`👤 Wallet: ${input}`);
  }
  console.log('═'.repeat(50));

  // Print addresses
  console.log('\n📬 Addresses:');
  for (const addr of addresses) {
    const balance = await getTokenBalance(provider, addr);
    const formattedBalance = balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const balanceUSD = balance * tokenPriceUSD;
    console.log(`   ${addr}`);
    console.log(`   └─ NEYNARTODES: ${formattedBalance} (~$${balanceUSD.toFixed(2)})`);
  }

  // Get total balance
  let totalBalance = 0;
  for (const addr of addresses) {
    totalBalance += await getTokenBalance(provider, addr);
  }
  const totalBalanceUSD = totalBalance * tokenPriceUSD;
  console.log(`\n💰 Total NEYNARTODES: ${totalBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} (~$${totalBalanceUSD.toFixed(2)})`);

  // Get recent transfers using direct blockchain queries
  console.log('\n📈 Recent Trades (24h) - Using HISTORICAL prices at time of trade:');
  const transfers = await getRecentTransfers(provider, addresses);

  if (transfers.length === 0) {
    console.log('   No trades in the last 24 hours');
  } else {
    let totalVolume = 0;
    let totalVolumeUSD = 0;
    for (const tx of transfers) {
      const emoji = tx.type === 'BUY' ? '🟢' : '🔴';
      // Get historical price at the block when this trade happened
      const historicalPrice = tx.blockNumber
        ? await getHistoricalTokenPriceUSD(provider, tx.blockNumber)
        : tokenPriceUSD;
      const volumeUSD = tx.amount * historicalPrice;
      console.log(`   ${emoji} ${tx.type}: ${tx.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} NEYNARTODES (~$${volumeUSD.toFixed(2)} @ block ${tx.blockNumber || 'N/A'})`);
      console.log(`      Time: ${tx.timestampStr}`);
      console.log(`      TX: ${tx.txHash.slice(0, 20)}...`);
      totalVolume += tx.amount;
      totalVolumeUSD += volumeUSD;
    }
    console.log(`\n   📊 24h Volume: ~${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })} NEYNARTODES (~$${totalVolumeUSD.toFixed(2)} historical)`);
  }

  // Check contest eligibility
  console.log('\n🏆 Active Contests:');
  const contests = await checkContestEligibility(provider, addresses);

  if (contests.length === 0) {
    console.log('   No active contests found');
  } else {
    for (const contest of contests) {
      const volumeEmoji = contest.volumeMet ? '✅' : '❌';
      console.log(`\n   Contest #${contest.contestId}`);
      console.log(`   ├─ Time Left: ${contest.timeLeft}`);
      console.log(`   ├─ Prize: ${contest.prizeAmount} ETH`);
      console.log(`   ├─ Volume Required: $${contest.volumeRequiredUSD}`);
      console.log(`   ├─ Your Volume (contest period): ${contest.volumeTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens (~$${contest.volumeUSD.toFixed(2)}) ${volumeEmoji}`);

      const reqs = [];
      if (contest.requirements.recast) reqs.push('Recast');
      if (contest.requirements.like) reqs.push('Like');
      if (contest.requirements.reply) reqs.push('Reply');
      console.log(`   └─ Social Requirements: ${reqs.length > 0 ? reqs.join(', ') : 'None'}`);

      if (contest.volumeMet) {
        console.log(`   ✅ VOLUME MET - Complete social requirements to qualify!`);
      } else {
        const needed = contest.volumeRequiredUSD - contest.volumeUSD;
        console.log(`   ❌ Need ~$${needed.toFixed(2)} more volume to qualify`);
      }
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('✨ Check complete!\n');
}

main().catch(console.error);
