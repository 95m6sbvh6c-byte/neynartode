// Query whitelist from PrizeNFT contract
// Run with: node get-whitelist.js

const ethers = require('ethers');

const PRIZE_NFT = '0x82f5A8CEffce9419886Bb0644FA5D3FB8295Ab81';
const BASE_RPC = 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC';
const NEYNAR_API_KEY = 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D';

// ABI for whitelist function
const ABI = [
  'function whitelist(address) view returns (bool)'
];

// Known addresses to check (from leaderboard, dev wallets, etc.)
// Add any addresses you've whitelisted here
const ADDRESSES_TO_CHECK = [
  '0x78EeAA6F014667A339fCF8b4eCd74743366603fb', // Dev wallet 1
  '0xAB4F21321A7A16eb57171994C7D7D1C808506E5d', // Dev wallet 2
  // Add more addresses below:
];

async function getWhitelist() {
  console.log('🦎 Checking whitelist status on PrizeNFT contract...\n');

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const contract = new ethers.Contract(PRIZE_NFT, ABI, provider);

  // First, let's get addresses from leaderboard API
  console.log('Fetching addresses from leaderboard...');
  try {
    const response = await fetch('https://frame-opal-eight.vercel.app/api/leaderboard');
    if (response.ok) {
      const data = await response.json();
      if (data.hosts) {
        data.hosts.forEach(host => {
          if (host.address && !ADDRESSES_TO_CHECK.includes(host.address)) {
            ADDRESSES_TO_CHECK.push(host.address);
          }
        });
      }
    }
  } catch (e) {
    console.log('Could not fetch leaderboard:', e.message);
  }

  console.log(`Checking ${ADDRESSES_TO_CHECK.length} addresses...\n`);

  const whitelisted = [];

  for (const addr of ADDRESSES_TO_CHECK) {
    try {
      const isWhitelisted = await contract.whitelist(addr);
      if (isWhitelisted) {
        whitelisted.push(addr);
        console.log(`  ✅ ${addr} - WHITELISTED`);
      } else {
        console.log(`  ❌ ${addr} - not whitelisted`);
      }
    } catch (e) {
      console.log(`  ⚠️ ${addr} - error: ${e.message}`);
    }
  }

  console.log(`Currently whitelisted: ${whitelisted.length} addresses\n`);
  console.log('Addresses:');
  whitelisted.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));

  // Resolve to Farcaster usernames
  console.log('\n🔍 Resolving Farcaster usernames...\n');

  const users = [];

  for (const addr of whitelisted) {
    try {
      const response = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_verification?address=${addr}`,
        {
          headers: { 'api_key': NEYNAR_API_KEY }
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.users && data.users.length > 0) {
          const user = data.users[0];
          users.push({
            address: addr,
            fid: user.fid,
            username: user.username,
            displayName: user.display_name
          });
          console.log(`  ✅ ${addr} → @${user.username} (${user.display_name})`);
        } else {
          users.push({ address: addr, username: null });
          console.log(`  ❓ ${addr} → No Farcaster account found`);
        }
      }
    } catch (err) {
      users.push({ address: addr, username: null });
      console.log(`  ❌ ${addr} → Error: ${err.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const fcUsers = users.filter(u => u.username);
  const noFcUsers = users.filter(u => !u.username);

  console.log(`\nTotal whitelisted: ${users.length}`);
  console.log(`With Farcaster: ${fcUsers.length}`);
  console.log(`Without Farcaster: ${noFcUsers.length}`);

  if (fcUsers.length > 0) {
    console.log('\n📢 CAST MENTIONS (copy this):');
    console.log('-'.repeat(40));
    const mentions = fcUsers.map(u => `@${u.username}`).join(' ');
    console.log(mentions);

    console.log('\n💰 AIRDROP ADDRESSES (for 20,000 NEYNARTODES each):');
    console.log('-'.repeat(40));
    users.forEach(u => console.log(u.address));
  }

  return users;
}

getWhitelist().catch(console.error);
