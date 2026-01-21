#!/usr/bin/env node
/**
 * Contest Stats Script
 *
 * Pulls all entries for a contest and calculates bonus entries.
 *
 * Usage: node scripts/contest-stats.js T-15
 */

require('dotenv').config();

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
  HOLDER_THRESHOLD: 100000000n * 10n ** 18n,
  MIN_REPLY_WORDS: 3,
  VOLUME_THRESHOLD_USD: 20,
};

const CONTEST_MANAGER_ABI = [
  'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
  'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
];

function parseContestId(contestIdStr) {
  if (!contestIdStr) return null;
  if (contestIdStr.startsWith('M-')) return { id: parseInt(contestIdStr.slice(2)), type: 'main' };
  if (contestIdStr.startsWith('T-')) return { id: parseInt(contestIdStr.slice(2)), type: 'test' };
  return null;
}

function formatTokenBalance(balance) {
  const num = Number(balance / (10n ** 18n));
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toFixed(0);
}

async function getContestStats(contestIdStr) {
  const parsed = parseContestId(contestIdStr);
  if (!parsed) {
    console.error('Invalid contest ID. Use M-X or T-X format.');
    process.exit(1);
  }

  const isTest = parsed.type === 'test';
  const numericId = parsed.id;

  console.log(`\n📊 CONTEST STATS: ${contestIdStr}`);
  console.log('═'.repeat(60));

  // Connect to blockchain
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contestManager = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, provider);

  // Get contest details from blockchain
  const getContestFn = isTest ? 'getTestContestFull' : 'getContestFull';
  const contest = await contestManager[getContestFn](numericId);

  const statusMap = { 0: 'Active', 1: 'PendingVRF', 2: 'Completed', 3: 'Cancelled' };
  const typeMap = { 0: 'ETH', 1: 'ERC20', 2: 'ERC721', 3: 'ERC1155' };

  console.log(`\n📋 Contest Details:`);
  console.log(`   Type: ${typeMap[Number(contest.contestType)] || 'Unknown'}`);
  console.log(`   Status: ${statusMap[Number(contest.status)] || 'Unknown'}`);
  console.log(`   Host: ${contest.host}`);
  console.log(`   Winner Count: ${contest.winnerCount}`);
  console.log(`   Started: ${new Date(Number(contest.startTime) * 1000).toLocaleString()}`);
  console.log(`   Ended: ${new Date(Number(contest.endTime) * 1000).toLocaleString()}`);

  if (contest.winners && contest.winners.length > 0) {
    console.log(`\n🏆 Winners:`);
    contest.winners.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
  }

  // Get cast hash
  const castId = contest.castId;
  const actualCastHash = castId.includes('|') ? castId.split('|')[0] : castId;
  console.log(`   Cast Hash: ${actualCastHash}`);

  // Connect to KV
  if (!process.env.KV_REST_API_URL) {
    console.error('\n❌ KV_REST_API_URL not configured');
    process.exit(1);
  }

  const { kv } = require('@vercel/kv');

  // Check for stored finalization data first (includes volume bonuses)
  const storedData = await kv.get(`finalize_data:${contestIdStr}`);
  if (storedData) {
    console.log('\n✅ Found stored finalization data (includes volume bonuses)');
    console.log('\n' + '═'.repeat(60));
    console.log('📊 PARTICIPANT BREAKDOWN');
    console.log('═'.repeat(60));
    console.log('\n');

    // Sort by entries descending
    const sorted = storedData.participants.sort((a, b) => b.entries - a.entries);

    for (const p of sorted) {
      const bonusStr = p.bonuses.length > 0
        ? ` [${p.bonuses.map(b => {
            if (b === 'holder') return '💎 Holder';
            if (b === 'reply') return `💬 Reply (${p.replyWords} words)`;
            if (b === 'share') return '📤 Shared';
            if (b === 'volume') return `📈 Volume ($${p.volumeUSD.toFixed(2)})`;
            return b;
          }).join(', ')}]`
        : '';
      console.log(`@${(p.username || `FID:${p.fid}`).padEnd(20)} ${p.entries} entries${bonusStr}`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(60));
    console.log(`   Unique Participants: ${storedData.summary.uniqueParticipants}`);
    console.log(`   Total Entries (with bonuses): ${storedData.summary.totalEntries}`);
    console.log(`   💎 Holder Bonuses: ${storedData.summary.holderBonuses}`);
    console.log(`   💬 Reply Bonuses: ${storedData.summary.replyBonuses}`);
    console.log(`   📤 Share Bonuses: ${storedData.summary.shareBonuses}`);
    console.log(`   📈 Volume Bonuses: ${storedData.summary.volumeBonuses}`);

    // Show burn/host stats if available
    if (storedData.summary.tokensBurned || storedData.summary.hostEarned) {
      console.log(`\n   🔥 Tokens Burned: ${storedData.summary.tokensBurned || '0'}`);
      console.log(`   💰 Host Earned: ${storedData.summary.hostEarned || '0'}`);
      if (storedData.summary.nonHolderEntries !== undefined) {
        console.log(`   Non-holder entries: ${storedData.summary.nonHolderEntries}`);
        console.log(`   Holder entries: ${storedData.summary.holderEntries}`);
      }
    }

    console.log(`\n   Finalized: ${new Date(storedData.timestamp).toLocaleString()}`);
    console.log(`   TX: ${storedData.txHash}`);
    return;
  }

  console.log('\n⚠️  No stored finalization data - calculating live (volume will be missing)...');

  // Get all FIDs who entered
  const entryKey = `contest_entries:${contestIdStr}`;
  const fids = await kv.smembers(entryKey);

  if (!fids || fids.length === 0) {
    console.log('\n❌ No entries found for this contest');
    process.exit(0);
  }

  console.log(`\n👥 Total Entries: ${fids.length}`);

  // Fetch user data from Neynar
  console.log('\n📡 Fetching user data from Neynar...');
  const users = new Map();

  const BATCH_SIZE = 100;
  for (let i = 0; i < fids.length; i += BATCH_SIZE) {
    const batch = fids.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch(
        `https://api.neynar.com/v2/farcaster/user/bulk?fids=${batch.join(',')}`,
        { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
      );

      if (response.ok) {
        const data = await response.json();
        for (const user of (data.users || [])) {
          const addresses = [];
          if (user.custody_address) {
            addresses.push(user.custody_address.toLowerCase());
          }
          if (user.verified_addresses?.eth_addresses) {
            addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
          }

          let primaryAddress = null;
          if (user.verified_addresses?.primary?.eth_address) {
            primaryAddress = user.verified_addresses.primary.eth_address.toLowerCase();
          } else if (user.verified_addresses?.eth_addresses?.length > 0) {
            primaryAddress = user.verified_addresses.eth_addresses[0].toLowerCase();
          } else if (user.custody_address) {
            primaryAddress = user.custody_address.toLowerCase();
          }

          users.set(user.fid, {
            fid: user.fid,
            username: user.username || '',
            displayName: user.display_name || user.username || '',
            addresses: [...new Set(addresses)],
            primaryAddress: primaryAddress || addresses[0]
          });
        }
      }
    } catch (e) {
      console.log(`   Error fetching batch: ${e.message}`);
    }
  }

  console.log(`   Fetched data for ${users.size} users`);

  // Check holder status
  console.log('\n💎 Checking holder status...');
  const neynartodes = new ethers.Contract(
    CONFIG.NEYNARTODES_TOKEN,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  const holderStatus = new Map();
  for (const user of users.values()) {
    try {
      const balances = await Promise.all(user.addresses.map(addr => neynartodes.balanceOf(addr).catch(() => 0n)));
      const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);
      holderStatus.set(user.fid, { isHolder: totalBalance >= CONFIG.HOLDER_THRESHOLD, balance: totalBalance });
    } catch (e) {
      holderStatus.set(user.fid, { isHolder: false, balance: 0n });
    }
  }

  // Check replies
  console.log('\n💬 Checking replies...');
  const repliersByFid = new Map();
  try {
    let cursor = null;
    let pageCount = 0;
    const maxPages = 20;

    do {
      const url = cursor
        ? `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${actualCastHash}&type=hash&reply_depth=1&limit=50&cursor=${cursor}`
        : `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${actualCastHash}&type=hash&reply_depth=1&limit=50`;

      const response = await fetch(url, { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } });
      if (!response.ok) break;

      const data = await response.json();
      const replies = data.conversation?.cast?.direct_replies || [];

      for (const reply of replies) {
        const fid = reply.author?.fid;
        if (!fid) continue;
        const wordCount = (reply.text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount >= CONFIG.MIN_REPLY_WORDS) {
          const existing = repliersByFid.get(fid);
          if (!existing || wordCount > existing.wordCount) {
            repliersByFid.set(fid, { fid, wordCount, text: reply.text?.substring(0, 50) });
          }
        }
      }

      cursor = data.next?.cursor;
      pageCount++;
      if (cursor) await new Promise(r => setTimeout(r, 100));
    } while (cursor && pageCount < maxPages);
  } catch (e) {
    console.log(`   Error fetching replies: ${e.message}`);
  }

  // Check sharers
  console.log('\n📤 Checking sharers...');
  const sharers = new Set();
  try {
    const shareKey = `contest_shares:${contestIdStr}`;
    const shareFids = await kv.smembers(shareKey);
    if (Array.isArray(shareFids)) {
      shareFids.forEach(fid => sharers.add(parseInt(fid)));
    }
  } catch (e) {
    console.log(`   Error fetching sharers: ${e.message}`);
  }

  // Output results
  console.log('\n' + '═'.repeat(60));
  console.log('📊 PARTICIPANT BREAKDOWN');
  console.log('═'.repeat(60));

  let totalEntries = 0;
  let holderBonusCount = 0;
  let replyBonusCount = 0;
  let shareBonusCount = 0;

  const participantData = [];

  for (const fid of fids) {
    const fidNum = parseInt(fid);
    const user = users.get(fidNum);
    const holder = holderStatus.get(fidNum);
    const reply = repliersByFid.get(fidNum);
    const shared = sharers.has(fidNum);

    let entries = 1;
    const bonuses = [];

    if (holder?.isHolder) {
      entries++;
      bonuses.push(`💎 Holder (${formatTokenBalance(holder.balance)})`);
      holderBonusCount++;
    }

    if (reply) {
      entries++;
      bonuses.push(`💬 Reply (${reply.wordCount} words)`);
      replyBonusCount++;
    }

    if (shared) {
      entries++;
      bonuses.push('📤 Shared');
      shareBonusCount++;
    }

    totalEntries += entries;

    participantData.push({
      fid: fidNum,
      username: user?.username || `FID:${fidNum}`,
      displayName: user?.displayName || '',
      entries,
      bonuses,
      holder: holder?.isHolder || false,
      balance: holder?.balance || 0n,
      replied: !!reply,
      replyWords: reply?.wordCount || 0,
      shared
    });
  }

  // Sort by entries (descending)
  participantData.sort((a, b) => b.entries - a.entries);

  // Print each participant
  console.log('\n');
  for (const p of participantData) {
    const bonusStr = p.bonuses.length > 0 ? ` [${p.bonuses.join(', ')}]` : '';
    console.log(`@${p.username.padEnd(20)} ${p.entries} entries${bonusStr}`);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(60));
  console.log(`   Unique Participants: ${fids.length}`);
  console.log(`   Total Entries (with bonuses): ${totalEntries}`);
  console.log(`   💎 Holder Bonuses: ${holderBonusCount}`);
  console.log(`   💬 Reply Bonuses: ${replyBonusCount}`);
  console.log(`   📤 Share Bonuses: ${shareBonusCount}`);
  console.log(`\n   Note: Volume bonus ($20+ trade) calculated only at finalization`);
}

// Run
const contestId = process.argv[2];
if (!contestId) {
  console.error('Usage: node scripts/contest-stats.js T-15');
  process.exit(1);
}

getContestStats(contestId)
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
