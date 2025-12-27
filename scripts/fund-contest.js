#!/usr/bin/env node
/**
 * Fund Prize Pool from Treasury
 *
 * This script allows you to add ETH from the treasury to the PrizeNFT pools
 * using the devAddToPool function (requires dev wallet).
 *
 * Usage:
 *   node fund-contest.js --season <SEASON_ID> --amount <ETH_AMOUNT>
 *   node fund-contest.js --season <SEASON_ID> --host <ETH> --voter <ETH>
 *
 * Examples:
 *   # Add 0.5 ETH to host pool
 *   node fund-contest.js --season 2 --amount 0.5
 *
 *   # Add specific amounts to each pool
 *   node fund-contest.js --season 2 --host 0.15 --voter 0.25
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: '/Users/brianwharton/Web_3_Tings/Neynartodes_Contracts /.env' });

// Contract addresses on Base
const PRIZE_NFT = '0x54E3972839A79fB4D1b0F70418141723d02E56e1'; // V2 deployed 2025-12-01

// ABI for devAddToPool - matches PrizeNFT_Season0.sol (V2)
const PRIZE_NFT_ABI = [
  'function devAddToPool(uint256 seasonId, uint256 hostAmount, uint256 voterAmount) external payable',
  'function devSponsorSeason(uint256 seasonId) external payable',
  'function seasons(uint256) external view returns (uint256 startTime, uint256 endTime, uint256 hostPool, uint256 voterPool, bool distributed)',
  'function devAddress() external view returns (address)',
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    seasonId: null,
    amount: null, // Total amount (goes to host pool)
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
  node fund-contest.js --season 2 --amount 0.5

  # Add 1 ETH to host pool
  node fund-contest.js --season 2 --amount 1

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
  if (!config.amount && !config.hostAmount && !config.voterAmount) {
    console.error('❌ Must specify either --amount or individual pool amounts (--host, --voter)');
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
  const rpcUrl = process.env.RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('\n🦎 NEYNARtodes Treasury Funder');
  console.log('================================\n');
  console.log(`📍 Wallet: ${wallet.address}`);

  // Connect to PrizeNFT
  const prizeNFT = new ethers.Contract(PRIZE_NFT, PRIZE_NFT_ABI, wallet);

  // Verify caller is dev (devAddToPool requires onlyDev modifier)
  const devAddr = await prizeNFT.devAddress();
  if (wallet.address.toLowerCase() !== devAddr.toLowerCase()) {
    console.error(`\n❌ Not authorized! This wallet is not the dev address.`);
    console.error(`   Your wallet: ${wallet.address}`);
    console.error(`   Dev wallet: ${devAddr}`);
    process.exit(1);
  }

  // Get current contract balance
  const currentBalance = await provider.getBalance(PRIZE_NFT);
  console.log(`\n📊 Current Contract Balance: ${ethers.formatEther(currentBalance)} ETH`);

  // Calculate amounts (no devPool in V2 - only host and voter)
  let hostAmount, voterAmount;

  if (config.amount) {
    // All funds go to host pool only
    hostAmount = ethers.parseEther(config.amount.toString());
    voterAmount = 0n;
  } else {
    // Use individual amounts
    hostAmount = config.hostAmount ? ethers.parseEther(config.hostAmount.toString()) : 0n;
    voterAmount = config.voterAmount ? ethers.parseEther(config.voterAmount.toString()) : 0n;
  }

  const totalValue = hostAmount + voterAmount;

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
    hostAmount,
    voterAmount,
    { value: totalValue }
  );

  console.log(`   TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

  // Show new contract balance
  const newBalance = await provider.getBalance(PRIZE_NFT);
  console.log(`\n📊 New Contract Balance: ${ethers.formatEther(newBalance)} ETH`);

  // Send notification to subscribers
  try {
    const amountETH = ethers.formatEther(hostAmount);
    const newTotalETH = ethers.formatEther(newBalance);
    console.log('\n📢 Sending notification to subscribers...');

    const response = await fetch('https://frame-opal-eight.vercel.app/api/send-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer neynartodes-notif-secret'
      },
      body: JSON.stringify({
        type: 'prize_pool_funded',
        data: {
          amount: amountETH,
          total: newTotalETH,
          season: config.seasonId,
        }
      })
    });

    const result = await response.json();
    console.log(`   📢 Notification sent: ${result.sent || 0} users notified`);
  } catch (e) {
    console.log(`   ⚠️ Could not send notification: ${e.message}`);
  }

  console.log('\n🎉 Treasury funds added successfully!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
