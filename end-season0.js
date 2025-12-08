/**
 * End Season 0 - Disable Whitelist on VotingManager
 *
 * This script calls endSeason0() on the VotingManager contract
 * to disable the whitelist requirement and open voting to everyone.
 *
 * Requirements:
 *   - PRIVATE_KEY in .env.local must be the contract owner
 *   - Owner address: 0x78EeAA6F014667A339fCF8b4eCd74743366603fb
 *
 * Usage:
 *   node end-season0.js
 */

const { ethers } = require('ethers');
require('dotenv').config({ path: '.env.local' });

const VOTING_MANAGER = '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8';

const ABI = [
  'function endSeason0() external',
  'function season0Active() view returns (bool)',
  'function owner() view returns (address)'
];

async function main() {
  console.log('='.repeat(60));
  console.log('END SEASON 0 - DISABLE WHITELIST');
  console.log('='.repeat(60));

  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`\nWallet: ${wallet.address}`);

  // Create contract instance
  const votingManager = new ethers.Contract(VOTING_MANAGER, ABI, wallet);

  // Check current status
  const owner = await votingManager.owner();
  const season0Active = await votingManager.season0Active();

  console.log(`Contract Owner: ${owner}`);
  console.log(`Season 0 Active: ${season0Active}`);

  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error('\nERROR: Your wallet is not the contract owner!');
    console.error(`Expected: ${owner}`);
    console.error(`Got: ${wallet.address}`);
    process.exit(1);
  }

  if (!season0Active) {
    console.log('\nSeason 0 is already ended. Whitelist is already disabled.');
    process.exit(0);
  }

  // Confirm before proceeding
  console.log('\n' + '='.repeat(60));
  console.log('READY TO DISABLE WHITELIST');
  console.log('='.repeat(60));
  console.log('\nThis will:');
  console.log('  - Set season0Active = false');
  console.log('  - Allow anyone with 20K+ tokens to vote');
  console.log('  - This action is IRREVERSIBLE on this contract');

  // Send transaction
  console.log('\nSending transaction...');
  const tx = await votingManager.endSeason0();
  console.log(`Transaction hash: ${tx.hash}`);
  console.log('Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log(`\nConfirmed in block ${receipt.blockNumber}`);

  // Verify the change
  const newSeason0Active = await votingManager.season0Active();
  console.log(`\nSeason 0 Active (after): ${newSeason0Active}`);

  if (!newSeason0Active) {
    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS! Whitelist has been disabled.');
    console.log('Anyone with 20K+ NEYNARTODES can now vote.');
    console.log('='.repeat(60));
  } else {
    console.error('\nERROR: season0Active is still true!');
  }
}

main().catch(console.error);
