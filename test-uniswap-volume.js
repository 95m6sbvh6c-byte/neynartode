/**
 * Test script for Token Volume Checker
 *
 * Usage:
 *   node test-uniswap-volume.js [wallet_address] [days_back]
 *
 * Examples:
 *   node test-uniswap-volume.js                                    # Show pool info
 *   node test-uniswap-volume.js 0xYourWallet                       # Check last 7 days
 *   node test-uniswap-volume.js 0xYourWallet 30                    # Check last 30 days
 */

const { getUniswapVolumes, findV2Pools, findV3Pools, getTokenPriceUSD, CONFIG } = require('./api/lib/uniswap-volume');
const { ethers } = require('ethers');

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔍 NEYNARTODES Volume Checker Test');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Token: ${CONFIG.NEYNARTODES_TOKEN}`);
  console.log('');

  // 1. Discover pools
  console.log('📊 Step 1: Discovering liquidity pools...');
  console.log('');

  const v2Pools = await findV2Pools(provider, CONFIG.NEYNARTODES_TOKEN);
  console.log(`   V2 Pools: ${v2Pools.length}`);
  for (const pool of v2Pools) {
    console.log(`     - ${pool.address}`);
  }

  const v3Pools = await findV3Pools(provider, CONFIG.NEYNARTODES_TOKEN);
  console.log(`   V3 Pools: ${v3Pools.length}`);
  for (const pool of v3Pools) {
    console.log(`     - ${pool.address} (fee: ${pool.fee / 10000}%)`);
  }

  console.log('   V4 Pools: Detected via Transfer events (singleton architecture)');
  console.log('');

  // 2. Get token price
  console.log('💰 Step 2: Token price...');
  const price = await getTokenPriceUSD(provider, CONFIG.NEYNARTODES_TOKEN);
  console.log(`   NEYNARTODES: $${price.toFixed(8)}`);
  console.log('');

  // 3. Check wallet volume (if provided)
  const testWallet = process.argv[2];
  const daysBack = parseInt(process.argv[3]) || 7;

  if (testWallet) {
    console.log(`📈 Step 3: Checking trading volume (last ${daysBack} days)...`);
    console.log(`   Wallet: ${testWallet}`);
    console.log('');

    const now = Math.floor(Date.now() / 1000);
    const startTime = now - (daysBack * 24 * 60 * 60);

    const results = await getUniswapVolumes(
      CONFIG.NEYNARTODES_TOKEN,
      [testWallet],
      0.001, // Tiny minimum to force volume check
      startTime,
      now
    );

    console.log('');
    console.log('   📋 Summary:');
    for (const r of results) {
      console.log(`     Address: ${r.address}`);
      console.log(`     Volume: ${r.volumeTokens?.toLocaleString() || 0} tokens`);
      console.log(`     Value: $${r.volumeUSD?.toFixed(4) || 0}`);

      // Check against different thresholds
      console.log('');
      console.log('     Would pass volume requirements:');
      console.log(`       $1 min:  ${r.volumeUSD >= 1 ? '✅' : '❌'}`);
      console.log(`       $5 min:  ${r.volumeUSD >= 5 ? '✅' : '❌'}`);
      console.log(`       $10 min: ${r.volumeUSD >= 10 ? '✅' : '❌'}`);
    }
  } else {
    console.log('ℹ️  Tip: Pass a wallet address to check trading volume');
    console.log('   Example: node test-uniswap-volume.js 0xYourWallet 7');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('✅ Test complete!');
  console.log('');
  console.log('📝 Note: Volume is calculated from ERC-20 Transfer events,');
  console.log('   which catches ALL trading (V2, V3, V4, aggregators, etc.)');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
