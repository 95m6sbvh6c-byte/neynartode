#!/usr/bin/env node
/**
 * Season 2 Host Leaderboard Airdrop
 *
 * Distributes NEYNARTODES tokens to top hosts from Season 2.
 *
 * Usage:
 *   node season2-airdrop.js
 *   node season2-airdrop.js --dry-run  (preview without sending)
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: '/Users/brianwharton/Web_3_Tings/Neynartodes_Contracts /.env' });

const NEYNARTODES = '0x8de1622fe07f56cda2e2273e615a513f1d828b07';
const RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

// Season 2 Host Airdrop Recipients (excluding ropiik)
const AIRDROP = [
  { rank: 2, username: 'jarwosamidi', address: '0x91F4FD5c834A023D8682FFE3105c93987027b175', amount: 300_000_000 },
  { rank: 3, username: 'qisiebensoul2049', address: '0xe62018E35Ac5790E1D033F89EF4e0093c6841B89', amount: 200_000_000 },
  { rank: 4, username: 'cryptomill', address: '0x71cE5605AB649d97446EF179Bc2983B18DDC9a48', amount: 100_000_000 },
  { rank: 5, username: 'biggsy', address: '0x5AeD6C04fc40241C8b804F718512Cb0754A0e8bB', amount: 100_000_000 },
  { rank: 6, username: 'designer.eth', address: '0xd9780EE158ed478A9dd57f62A4BF2EF508D95541', amount: 100_000_000 },
  { rank: 7, username: 'blockchainhof', address: '0x8276Dbde6AF19C414c2f65469E29a9CBd910b8eF', amount: 100_000_000 },
  { rank: 9, username: 'whyudprastyo', address: '0xAbacfD4c6d2E21802910A7e667E6efF159602535', amount: 100_000_000 },
  { rank: 10, username: 'blockx', address: '0x5e034B2b0B1D7A78c246Fc1049Fd6aC0af00b058', amount: 100_000_000 },
];

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('\n🦎 Season 2 Host Leaderboard Airdrop');
  console.log('=====================================\n');

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No transactions will be sent\n');
  }

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey && !isDryRun) {
    console.error('❌ PRIVATE_KEY environment variable not set');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;

  if (wallet) {
    console.log(`📍 Sender: ${wallet.address}`);
  }

  const token = new ethers.Contract(NEYNARTODES, ERC20_ABI, wallet || provider);
  const decimals = await token.decimals();
  const symbol = await token.symbol();

  // Calculate total
  const totalAmount = AIRDROP.reduce((sum, r) => sum + r.amount, 0);
  console.log(`\n💰 Total to distribute: ${totalAmount.toLocaleString()} ${symbol}`);

  // Check balance
  if (wallet) {
    const balance = await token.balanceOf(wallet.address);
    const balanceFormatted = Number(balance) / Math.pow(10, Number(decimals));
    console.log(`📊 Your balance: ${balanceFormatted.toLocaleString()} ${symbol}`);

    if (balanceFormatted < totalAmount) {
      console.error(`\n❌ Insufficient balance! Need ${totalAmount.toLocaleString()}, have ${balanceFormatted.toLocaleString()}`);
      process.exit(1);
    }
  }

  console.log('\n📋 Airdrop Recipients:');
  console.log('-'.repeat(70));

  for (const recipient of AIRDROP) {
    console.log(`   #${recipient.rank} @${recipient.username}: ${recipient.amount.toLocaleString()} ${symbol}`);
    console.log(`      → ${recipient.address}`);
  }

  if (isDryRun) {
    console.log('\n✅ Dry run complete! Run without --dry-run to execute transfers.');
    return;
  }

  console.log('\n🚀 Sending transfers...\n');

  const results = [];

  for (const recipient of AIRDROP) {
    try {
      const amount = ethers.parseUnits(recipient.amount.toString(), decimals);

      console.log(`   Sending ${recipient.amount.toLocaleString()} to @${recipient.username}...`);

      const tx = await token.transfer(recipient.address, amount);
      console.log(`   TX: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}\n`);

      results.push({
        username: recipient.username,
        address: recipient.address,
        amount: recipient.amount,
        txHash: tx.hash,
        success: true,
      });

      // Small delay between transfers
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      console.error(`   ❌ Failed: ${error.message}\n`);
      results.push({
        username: recipient.username,
        address: recipient.address,
        amount: recipient.amount,
        error: error.message,
        success: false,
      });
    }
  }

  // Summary
  console.log('\n📊 Summary:');
  console.log('-'.repeat(50));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`   ✅ Successful: ${successful.length}`);
  console.log(`   ❌ Failed: ${failed.length}`);

  if (successful.length > 0) {
    const totalSent = successful.reduce((sum, r) => sum + r.amount, 0);
    console.log(`   💰 Total sent: ${totalSent.toLocaleString()} ${symbol}`);
  }

  if (failed.length > 0) {
    console.log('\n⚠️ Failed transfers:');
    for (const f of failed) {
      console.log(`   - @${f.username}: ${f.error}`);
    }
  }

  console.log('\n🎉 Airdrop complete!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
