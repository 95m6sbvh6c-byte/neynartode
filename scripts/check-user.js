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
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  BLOCKSCOUT_API: 'https://base.blockscout.com/api/v2',
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

/**
 * Get Farcaster user by username
 */
async function getUserByUsername(username) {
  // Remove @ if present
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
 * Get recent NEYNARTODES transfers for addresses
 */
async function getRecentTransfers(addresses) {
  const transfers = [];
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  try {
    const response = await fetch(
      `${CONFIG.BLOCKSCOUT_API}/tokens/${CONFIG.NEYNARTODES}/transfers`
    );

    if (!response.ok) return transfers;

    const data = await response.json();
    const items = data.items || [];

    // Normalize addresses for comparison
    const normalizedAddresses = addresses.map(a => a.toLowerCase());

    for (const item of items) {
      const fromAddr = item.from?.hash?.toLowerCase();
      const toAddr = item.to?.hash?.toLowerCase();
      const timestamp = new Date(item.timestamp).getTime();

      // Check if within last 24 hours and involves user's address
      if (timestamp >= oneDayAgo) {
        if (normalizedAddresses.includes(fromAddr) || normalizedAddresses.includes(toAddr)) {
          const value = Number(item.total?.value || 0) / 1e18;
          transfers.push({
            type: normalizedAddresses.includes(fromAddr) ? 'SELL' : 'BUY',
            amount: value,
            from: fromAddr,
            to: toAddr,
            timestamp: new Date(item.timestamp).toLocaleString(),
            txHash: item.transaction_hash,
          });
        }
      }
    }
  } catch (e) {
    console.error('Error fetching transfers:', e.message);
  }

  return transfers;
}

/**
 * Get active contests and check if user qualifies
 */
async function checkContestEligibility(provider, addresses) {
  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, CONTEST_ESCROW_ABI, provider);
  const results = [];

  try {
    const nextId = await contract.nextContestId();
    const totalContests = Number(nextId) - 1;
    const now = Math.floor(Date.now() / 1000);

    // Check last 10 contests for active ones
    for (let i = totalContests; i >= Math.max(1, totalContests - 10); i--) {
      try {
        const contest = await contract.getContest(i);
        const [host, prizeToken, prizeAmount, startTime, endTime, castId, tokenReq, volumeReq, status, winner] = contest;

        const contestEndTime = Number(endTime);
        const contestStatus = Number(status);

        // Only check active contests
        if (contestStatus === 0 && contestEndTime > now) {
          const qualifiedEntries = await contract.getQualifiedEntries(i);
          const normalizedAddresses = addresses.map(a => a.toLowerCase());
          const isQualified = qualifiedEntries.some(e => normalizedAddresses.includes(e.toLowerCase()));

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
            isQualified,
            timeLeft: `${hoursLeft}h ${minsLeft}m`,
            volumeRequired: Number(volumeReq) / 1e18,
            participantCount: qualifiedEntries.length,
            requirements: {
              recast: requireRecast,
              like: requireLike,
              reply: requireReply,
            },
            prizeAmount: Number(prizeAmount) / 1e18,
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
      // Add all verified addresses
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

  // Print user info
  console.log('═'.repeat(50));
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
    console.log(`   ${addr}`);
    console.log(`   └─ NEYNARTODES: ${formattedBalance}`);
  }

  // Get total balance
  let totalBalance = 0;
  for (const addr of addresses) {
    totalBalance += await getTokenBalance(provider, addr);
  }
  console.log(`\n💰 Total NEYNARTODES: ${totalBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

  // Get recent transfers
  console.log('\n📈 Recent Trades (24h):');
  const transfers = await getRecentTransfers(addresses);

  if (transfers.length === 0) {
    console.log('   No trades in the last 24 hours');
  } else {
    let totalVolume = 0;
    for (const tx of transfers) {
      const emoji = tx.type === 'BUY' ? '🟢' : '🔴';
      console.log(`   ${emoji} ${tx.type}: ${tx.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} NEYNARTODES`);
      console.log(`      Time: ${tx.timestamp}`);
      console.log(`      TX: ${tx.txHash.slice(0, 20)}...`);
      totalVolume += tx.amount;
    }
    console.log(`\n   📊 24h Volume: ~${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })} NEYNARTODES`);
  }

  // Check contest eligibility
  console.log('\n🏆 Active Contests:');
  const contests = await checkContestEligibility(provider, addresses);

  if (contests.length === 0) {
    console.log('   No active contests found');
  } else {
    for (const contest of contests) {
      const statusEmoji = contest.isQualified ? '✅' : '❌';
      console.log(`\n   Contest #${contest.contestId} ${statusEmoji}`);
      console.log(`   ├─ Status: ${contest.isQualified ? 'QUALIFIED' : 'NOT QUALIFIED'}`);
      console.log(`   ├─ Time Left: ${contest.timeLeft}`);
      console.log(`   ├─ Prize: ${contest.prizeAmount} ETH`);
      console.log(`   ├─ Volume Required: $${contest.volumeRequired}`);
      console.log(`   ├─ Participants: ${contest.participantCount}`);

      const reqs = [];
      if (contest.requirements.recast) reqs.push('Recast');
      if (contest.requirements.like) reqs.push('Like');
      if (contest.requirements.reply) reqs.push('Reply');
      console.log(`   └─ Social: ${reqs.length > 0 ? reqs.join(', ') : 'None'}`);
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('✨ Check complete!\n');
}

main().catch(console.error);
