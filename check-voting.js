const { ethers } = require('ethers');
require('dotenv').config({ path: '.env.local' });

const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/');
const VOTING_MANAGER = '0x267Bd7ae64DA1060153b47d6873a8830dA4236f8';
const NEYNARTODES = '0x8de1622fe07f56cda2e2273e615a513f1d828b07';

// Get user address from Neynar API
async function getUserAddress(username) {
  const res = await fetch(`https://api.neynar.com/v2/farcaster/user/by_username?username=${username}`, {
    headers: { 'api_key': process.env.NEYNAR_API_KEY }
  });
  if (!res.ok) throw new Error('Neynar API error');
  const data = await res.json();
  const user = data.user;
  console.log(`\nUser: @${user.username} (FID: ${user.fid})`);
  console.log(`Custody: ${user.custody_address}`);
  console.log(`Verified: ${user.verified_addresses?.eth_addresses?.join(', ') || 'none'}`);
  return {
    custody: user.custody_address,
    verified: user.verified_addresses?.eth_addresses || []
  };
}

async function main() {
  const username = process.argv[2] || 'jarwosamidi';

  console.log('='.repeat(60));
  console.log('VOTING ELIGIBILITY CHECK');
  console.log('='.repeat(60));

  // Get user addresses
  const addresses = await getUserAddress(username);
  const allAddresses = [addresses.custody, ...addresses.verified].filter(Boolean);

  const votingABI = [
    'function whitelisted(address) view returns (bool)',
    'function canVote(address) view returns (bool)',
    'function getRemainingVotes(address) view returns (uint256)',
    'function voteCount(address) view returns (uint256)'
  ];

  const tokenABI = [
    'function balanceOf(address) view returns (uint256)'
  ];

  const votingManager = new ethers.Contract(VOTING_MANAGER, votingABI, provider);
  const token = new ethers.Contract(NEYNARTODES, tokenABI, provider);

  console.log('\n' + '='.repeat(60));
  console.log('CHECKING EACH ADDRESS:');
  console.log('='.repeat(60));

  for (const addr of allAddresses) {
    console.log(`\n--- ${addr} ---`);
    try {
      // Check token balance first (this always works)
      const balance = await token.balanceOf(addr);
      console.log(`  Token Balance: ${ethers.formatEther(balance)} NEYNARTODES`);

      // Try voting contract calls (may fail if address format issues)
      try {
        const whitelisted = await votingManager.whitelisted(addr);
        console.log(`  Whitelisted: ${whitelisted}`);
        if (!whitelisted) console.log(`  ISSUE: Not whitelisted on contract!`);
      } catch (e) {
        console.log(`  Whitelisted: ERROR - ${e.code}`);
      }

      try {
        const canVote = await votingManager.canVote(addr);
        console.log(`  Can Vote: ${canVote}`);
      } catch (e) {
        console.log(`  Can Vote: ERROR - ${e.code}`);
      }

      try {
        const remaining = await votingManager.getRemainingVotes(addr);
        console.log(`  Remaining Votes: ${remaining.toString()}`);
      } catch (e) {
        console.log(`  Remaining Votes: ERROR - ${e.code}`);
      }

      if (balance < ethers.parseEther('1000')) {
        console.log(`  ISSUE: Insufficient balance (need 1000)`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

main().catch(console.error);
