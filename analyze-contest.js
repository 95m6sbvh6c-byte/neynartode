// Comprehensive eligibility analysis for NFT Contest #3
const { ethers } = require('ethers');
require('dotenv').config({ path: '.env.local' });

const CONFIG = {
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY,
  BASE_RPC: 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922'
};

const NFT_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
  'function getQualifiedEntries(uint256) view returns (address[])'
];

async function neynarGet(endpoint) {
  const res = await fetch(`https://api.neynar.com/v2/farcaster/${endpoint}`, {
    headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
  });
  if (!res.ok) throw new Error(`Neynar error: ${res.status}`);
  return res.json();
}

async function analyzeContest(contestId) {
  console.log('='.repeat(80));
  console.log(`NFT CONTEST #${contestId} - FULL ELIGIBILITY ANALYSIS`);
  console.log('='.repeat(80));

  // STEP 1: Get contest from contract
  console.log('\n[STEP 1] FETCHING CONTEST FROM CONTRACT...');
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contract = new ethers.Contract(CONFIG.NFT_CONTEST_ESCROW, NFT_ESCROW_ABI, provider);

  const contest = await contract.getContest(contestId);
  // NFT ABI: host(0), nftType(1), nftContract(2), tokenId(3), amount(4), startTime(5), endTime(6), castId(7), tokenRequirement(8), volumeRequirement(9), status(10), winner(11)
  const castIdFull = contest[7]; // castId field

  // Parse castId format: {hash}|R{r}L{l}P{p} or {hash}|R{r}L{l}P{p}|{imageUrl}
  const parts = castIdFull.split('|');
  const castHash = parts[0];
  const requirementsStr = parts[1] || 'R1L1P0';

  const reqMatch = requirementsStr.match(/R(\d+)L(\d+)P(\d+)/);
  const requirements = {
    recast: reqMatch ? parseInt(reqMatch[1]) > 0 : true,
    like: reqMatch ? parseInt(reqMatch[2]) > 0 : true,
    reply: reqMatch ? parseInt(reqMatch[3]) > 0 : false
  };

  console.log(`   Cast ID: ${castIdFull}`);
  console.log(`   Cast Hash: ${castHash}`);
  console.log(`   Requirements: Recast=${requirements.recast}, Like=${requirements.like}, Reply=${requirements.reply}`);
  console.log(`   Status: ${['Active', 'PendingVRF', 'Completed', 'Cancelled'][Number(contest[10])]}`);
  console.log(`   Host: ${contest[0]}`);
  console.log(`   NFT Contract: ${contest[2]}`);
  console.log(`   Token ID: ${contest[3].toString()}`);
  console.log(`   Amount: ${contest[4].toString()}`);

  // STEP 2: Get original cast details
  console.log('\n[STEP 2] FETCHING ORIGINAL CAST...');
  const castData = await neynarGet(`cast?identifier=${castHash}&type=hash`);
  const cast = castData.cast;

  console.log(`   Author: @${cast.author.username} (FID: ${cast.author.fid})`);
  console.log(`   Text: "${cast.text.slice(0, 100)}${cast.text.length > 100 ? '...' : ''}"`);
  console.log(`   Reactions: ${cast.reactions?.recasts_count || 0} recasts, ${cast.reactions?.likes_count || 0} likes`);
  console.log(`   Replies: ${cast.replies?.count || 0}`);

  // STEP 3: Get engagement on original cast
  console.log('\n[STEP 3] FETCHING ENGAGEMENT ON ORIGINAL CAST...');

  // Get recasters
  const recastersData = await neynarGet(`reactions/cast?hash=${castHash}&types=recasts&limit=100`);
  const recasters = new Map();
  for (const reaction of recastersData.reactions || []) {
    recasters.set(reaction.user.fid, {
      username: reaction.user.username,
      address: reaction.user.verified_addresses?.eth_addresses?.[0] || null
    });
  }
  console.log(`   Recasters (${recasters.size}): ${[...recasters.values()].map(u => '@' + u.username).join(', ')}`);

  // Get likers
  const likersData = await neynarGet(`reactions/cast?hash=${castHash}&types=likes&limit=100`);
  const likers = new Map();
  for (const reaction of likersData.reactions || []) {
    likers.set(reaction.user.fid, {
      username: reaction.user.username,
      address: reaction.user.verified_addresses?.eth_addresses?.[0] || null
    });
  }
  console.log(`   Likers (${likers.size}): ${[...likers.values()].map(u => '@' + u.username).join(', ')}`);

  // Get repliers
  const repliesData = await neynarGet(`cast/conversation?identifier=${castHash}&type=hash&reply_depth=1&include_chronological_parent_casts=false&limit=50`);
  const repliers = new Map();
  const directReplies = repliesData.conversation?.cast?.direct_replies || [];
  for (const reply of directReplies) {
    repliers.set(reply.author.fid, {
      username: reply.author.username,
      address: reply.author.verified_addresses?.eth_addresses?.[0] || null
    });
  }
  console.log(`   Repliers (${repliers.size}): ${[...repliers.values()].map(u => '@' + u.username).join(', ')}`);

  // STEP 4: Check quote casts using Neynar API
  console.log('\n[STEP 4] FETCHING QUOTE CASTS VIA NEYNAR API...');
  const quotesData = await neynarGet(`cast/quotes?identifier=${castHash}&type=hash&limit=100`);
  const quoteCasts = quotesData.casts || [];

  console.log(`   Found ${quoteCasts.length} quote casts:`);

  const quoteEngagement = [];

  for (const quoteCast of quoteCasts) {
    console.log(`\n   --- Quote Cast: ${quoteCast.hash.slice(0, 16)}...`);
    console.log(`       Author: @${quoteCast.author.username} (FID: ${quoteCast.author.fid})`);
    console.log(`       Text: "${quoteCast.text.slice(0, 80)}${quoteCast.text.length > 80 ? '...' : ''}"`);

    // Get engagement on this quote cast
    const qRecastersData = await neynarGet(`reactions/cast?hash=${quoteCast.hash}&types=recasts&limit=100`);
    const qRecasters = new Map();
    for (const r of qRecastersData.reactions || []) {
      qRecasters.set(r.user.fid, {
        username: r.user.username,
        address: r.user.verified_addresses?.eth_addresses?.[0] || null
      });
    }

    const qLikersData = await neynarGet(`reactions/cast?hash=${quoteCast.hash}&types=likes&limit=100`);
    const qLikers = new Map();
    for (const r of qLikersData.reactions || []) {
      qLikers.set(r.user.fid, {
        username: r.user.username,
        address: r.user.verified_addresses?.eth_addresses?.[0] || null
      });
    }

    const qRepliesData = await neynarGet(`cast/conversation?identifier=${quoteCast.hash}&type=hash&reply_depth=1&include_chronological_parent_casts=false&limit=50`);
    const qRepliers = new Map();
    const qDirectReplies = qRepliesData.conversation?.cast?.direct_replies || [];
    for (const reply of qDirectReplies) {
      qRepliers.set(reply.author.fid, {
        username: reply.author.username,
        address: reply.author.verified_addresses?.eth_addresses?.[0] || null
      });
    }

    console.log(`       Recasters (${qRecasters.size}): ${[...qRecasters.values()].map(u => '@' + u.username).join(', ') || 'none'}`);
    console.log(`       Likers (${qLikers.size}): ${[...qLikers.values()].map(u => '@' + u.username).join(', ') || 'none'}`);
    console.log(`       Repliers (${qRepliers.size}): ${[...qRepliers.values()].map(u => '@' + u.username).join(', ') || 'none'}`);

    quoteEngagement.push({
      hash: quoteCast.hash,
      author: quoteCast.author.username,
      recasters: qRecasters,
      likers: qLikers,
      repliers: qRepliers
    });
  }

  // STEP 5: Combine all engagement and determine eligibility
  console.log('\n[STEP 5] COMBINING ENGAGEMENT & DETERMINING ELIGIBILITY...');

  // Merge all engagement across original + quote casts
  const allRecasters = new Map(recasters);
  const allLikers = new Map(likers);
  const allRepliers = new Map(repliers);

  for (const qe of quoteEngagement) {
    for (const [fid, user] of qe.recasters) {
      if (!allRecasters.has(fid)) allRecasters.set(fid, user);
    }
    for (const [fid, user] of qe.likers) {
      if (!allLikers.has(fid)) allLikers.set(fid, user);
    }
    for (const [fid, user] of qe.repliers) {
      if (!allRepliers.has(fid)) allRepliers.set(fid, user);
    }
  }

  console.log(`\n   COMBINED TOTALS:`);
  console.log(`   Total unique recasters: ${allRecasters.size}`);
  console.log(`   Total unique likers: ${allLikers.size}`);
  console.log(`   Total unique repliers: ${allRepliers.size}`);

  // Find all unique users who engaged
  const allUsers = new Map();
  for (const [fid, user] of allRecasters) allUsers.set(fid, { ...user, fid, recasted: true });
  for (const [fid, user] of allLikers) {
    if (allUsers.has(fid)) allUsers.get(fid).liked = true;
    else allUsers.set(fid, { ...user, fid, liked: true });
  }
  for (const [fid, user] of allRepliers) {
    if (allUsers.has(fid)) allUsers.get(fid).replied = true;
    else allUsers.set(fid, { ...user, fid, replied: true });
  }

  // Determine eligibility for each user
  const eligible = [];
  const ineligible = [];

  console.log('\n   INDIVIDUAL USER ANALYSIS:');
  console.log('-'.repeat(80));

  for (const [fid, user] of allUsers) {
    const hasRecast = user.recasted || false;
    const hasLike = user.liked || false;
    const hasReply = user.replied || false;

    const meetsRecast = !requirements.recast || hasRecast;
    const meetsLike = !requirements.like || hasLike;
    const meetsReply = !requirements.reply || hasReply;
    const isEligible = meetsRecast && meetsLike && meetsReply;

    const status = isEligible ? 'ELIGIBLE' : 'INELIGIBLE';
    const actions = [];
    if (hasRecast) actions.push('recasted');
    if (hasLike) actions.push('liked');
    if (hasReply) actions.push('replied');

    console.log(`   @${user.username} (FID: ${fid}): ${status}`);
    console.log(`      Actions: ${actions.join(', ') || 'none'}`);
    console.log(`      Address: ${user.address || 'NO WALLET CONNECTED'}`);

    if (!meetsRecast) console.log(`      Missing: RECAST required`);
    if (!meetsLike) console.log(`      Missing: LIKE required`);
    if (!meetsReply) console.log(`      Missing: REPLY required`);

    if (isEligible && user.address) {
      eligible.push({ fid, username: user.username, address: user.address });
    } else {
      const reasons = [];
      if (!meetsRecast) reasons.push('no recast');
      if (!meetsLike) reasons.push('no like');
      if (!meetsReply) reasons.push('no reply');
      if (!user.address) reasons.push('no wallet');
      ineligible.push({ fid, username: user.username, reasons });
    }
  }

  // FINAL SUMMARY
  console.log('\n' + '='.repeat(80));
  console.log('FINAL ELIGIBILITY SUMMARY');
  console.log('='.repeat(80));

  console.log(`\nRequirements: Recast=${requirements.recast}, Like=${requirements.like}, Reply=${requirements.reply}`);
  console.log(`\nPosts Checked:`);
  console.log(`   1. Original: ${castHash.slice(0, 16)}... by @${cast.author.username}`);
  for (let i = 0; i < quoteCasts.length; i++) {
    console.log(`   ${i + 2}. Quote: ${quoteCasts[i].hash.slice(0, 16)}... by @${quoteCasts[i].author.username}`);
  }

  console.log(`\nELIGIBLE USERS (${eligible.length}):`);
  for (const user of eligible) {
    console.log(`   @${user.username} - ${user.address}`);
  }

  console.log(`\nINELIGIBLE USERS (${ineligible.length}):`);
  for (const user of ineligible) {
    console.log(`   @${user.username} - Reasons: ${user.reasons.join(', ')}`);
  }

  console.log('\n' + '='.repeat(80));
}

// Run for contest #3
analyzeContest(3).catch(console.error);
