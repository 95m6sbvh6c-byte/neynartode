#!/usr/bin/env node
/**
 * Fund Prize Pool from Treasury
 *
 * This script allows you to add ETH from the treasury to the PrizeNFT pools
 * using the devAddToPool function.
 *
 * Usage:
 *   node fund-contest.js --season <SEASON_ID> --amount <ETH_AMOUNT>
 *   node fund-contest.js --season <SEASON_ID> --dev <ETH> --host <ETH> --voter <ETH>
 *
 * Examples:
 *   # Add 0.5 ETH split across pools (20% dev, 30% host, 50% voter)
 *   node fund-contest.js --season 0 --amount 0.5
 *
 *   # Add specific amounts to each pool
 *   node fund-contest.js --season 0 --dev 0.1 --host 0.15 --voter 0.25
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Contract addresses on Base
const PRIZE_NFT = '0x82f5A8CEffce9419886Bb0644FA5D3FB8295Ab81';

// ABI for devAddToPool
const PRIZE_NFT_ABI = [
  'function devAddToPool(uint256 seasonId, uint256 devAmount, uint256 hostAmount, uint256 voterAmount) external payable',
  'function devSponsor(uint256 seasonId) external payable',
  'function seasons(uint256) external view returns (uint256 startTime, uint256 endTime, uint256 devPool, uint256 hostPool, uint256 voterPool, uint256 totalContests, bool active)',
  'function dev() external view returns (address)',
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    seasonId: null,
    amount: null, // Total amount (will be split)
    devAmount: null,
    hostAmount: null,
    voterAmount: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--season':
        config.seasonId = parseInt(args[++i]);
        break;
      case '--amount':
        config.amount = parseFloat(args[++i]);
        break;
      case '--dev':
        config.devAmount = parseFloat(args[++i]);
        break;
      case '--host':
        config.hostAmount = parseFloat(args[++i]);
        break;
      case '--voter':
        config.voterAmount = parseFloat(args[++i]);
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
Fund Host Prize Pool from Treasury
==================================

This script adds ETH to the PrizeNFT host pool using devAddToPool.

Usage:
  node fund-contest.js [options]

Options:
  --season <id>       Season ID to fund (required)
  --amount <eth>      ETH amount to add to host pool (required)
  --help              Show this help message

Examples:
  # Add 0.5 ETH to host pool
  node fund-contest.js --season 0 --amount 0.5

  # Add 1 ETH to host pool
  node fund-contest.js --season 0 --amount 1

Environment Variables:
  PRIVATE_KEY         Your dev wallet private key
  RPC_URL             Base RPC URL (default: Alchemy)
`);
}

async function main() {
  const config = parseArgs();

  // Validate required args
  if (config.seasonId === null) {
    console.error('❌ Missing required argument: --season');
    console.log('   Run with --help for usage information');
    process.exit(1);
  }

  // Must have either total amount or individual amounts
  if (!config.amount && !config.devAmount && !config.hostAmount && !config.voterAmount) {
    console.error('❌ Must specify either --amount or individual pool amounts (--dev, --host, --voter)');
    process.exit(1);
  }

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY environment variable not set');
    console.log('   Set it in .env file or export PRIVATE_KEY=your_key');
    process.exit(1);
  }

  // Connect to Base
  const rpcUrl = process.env.RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('\n🦎 NEYNARtodes Treasury Funder');
  console.log('================================\n');
  console.log(`📍 Wallet: ${wallet.address}`);

  // Connect to PrizeNFT
  const prizeNFT = new ethers.Contract(PRIZE_NFT, PRIZE_NFT_ABI, wallet);

  // Verify caller is dev
  const devAddress = await prizeNFT.dev();
  if (wallet.address.toLowerCase() !== devAddress.toLowerCase()) {
    console.error(`\n❌ Not authorized! This wallet is not the dev.`);
    console.error(`   Your wallet: ${wallet.address}`);
    console.error(`   Dev wallet:  ${devAddress}`);
    process.exit(1);
  }

  // Get current season info
  const season = await prizeNFT.seasons(config.seasonId);
  console.log(`\n📊 Season ${config.seasonId} Current Pools:`);
  console.log(`   Dev Pool:   ${ethers.formatEther(season.devPool)} ETH`);
  console.log(`   Host Pool:  ${ethers.formatEther(season.hostPool)} ETH`);
  console.log(`   Voter Pool: ${ethers.formatEther(season.voterPool)} ETH`);

  // Calculate amounts
  let devAmount, hostAmount, voterAmount;

  if (config.amount) {
    // All funds go to host pool only
    const total = ethers.parseEther(config.amount.toString());
    devAmount = 0n;
    hostAmount = total;
    voterAmount = 0n;
  } else {
    // Use individual amount for host pool only
    devAmount = 0n;
    hostAmount = config.hostAmount ? ethers.parseEther(config.hostAmount.toString()) : 0n;
    voterAmount = 0n;
  }

  const totalValue = devAmount + hostAmount + voterAmount;

  console.log(`\n💰 Adding to Host Pool: ${ethers.formatEther(hostAmount)} ETH`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  if (balance < totalValue) {
    console.error(`\n❌ Insufficient balance! Need ${ethers.formatEther(totalValue)} ETH, have ${ethers.formatEther(balance)}`);
    process.exit(1);
  }

  console.log('\n🚀 Sending transaction...');

  const tx = await prizeNFT.devAddToPool(
    config.seasonId,
    devAmount,
    hostAmount,
    voterAmount,
    { value: totalValue }
  );

  console.log(`   TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

  // Show new pool amounts
  const newSeason = await prizeNFT.seasons(config.seasonId);
  console.log(`\n📊 Season ${config.seasonId} Updated Pools:`);
  console.log(`   Dev Pool:   ${ethers.formatEther(newSeason.devPool)} ETH`);
  console.log(`   Host Pool:  ${ethers.formatEther(newSeason.hostPool)} ETH`);
  console.log(`   Voter Pool: ${ethers.formatEther(newSeason.voterPool)} ETH`);

  console.log('\n🎉 Treasury funds added successfully!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
