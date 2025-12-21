/**
 * Contest Participants API
 *
 * Returns participant profile pictures for a contest.
 * Used to display floating PFPs in the active contests section.
 *
 * GET /api/contest-participants?contestId=112
 * Returns: { participants: [{ fid, pfpUrl, username, hasReplied }] }
 */

const { ethers } = require('ethers');

// Contract ABIs for fetching castId
const CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const NFT_CONTEST_ESCROW_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
];

const CONTEST_MANAGER_V2_ABI = [
  'function getContest(uint256 _contestId) external view returns (address host, uint8 contestType, uint8 status, string memory castId, uint256 endTime, address prizeToken, uint256 prizeAmount, uint8 winnerCount, address[] memory winners)',
];

// Contract addresses
const CONTEST_ESCROW_ADDRESS = '0xfe9CC44e275d61f2D0DF9e3C1d6D6f72C46257a3';
const NFT_CONTEST_ESCROW_ADDRESS = '0xF36dc2A66f5Fd29c51C1e68920B5E4cbDbC19F65';
const CONTEST_MANAGER_V2_ADDRESS = '0xa63c93dc3a44243c5e27650e3dc11eac96d89d75';
const V2_START_ID = 105;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache for 2 minutes
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contestId } = req.query;

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId parameter' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D';

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ participants: [], error: 'KV not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Get all FIDs who entered this contest
    // Check both key formats and COMBINE results for V2 contests
    const contestIdNum = parseInt(contestId);
    const isV2 = contestIdNum >= V2_START_ID;

    let entryFids = [];

    if (isV2) {
      // For V2 contests, check BOTH key formats and combine (entries may exist in either)
      const v2Key = `contest_entries:v2-${contestId}`;
      const legacyKey = `contest_entries:${contestId}`;

      let v2Fids = await kv.smembers(v2Key);
      let legacyFids = await kv.smembers(legacyKey);

      // Handle null/undefined
      v2Fids = Array.isArray(v2Fids) ? v2Fids : [];
      legacyFids = Array.isArray(legacyFids) ? legacyFids : [];

      // Combine and dedupe
      const allFids = new Set([...v2Fids, ...legacyFids]);
      entryFids = Array.from(allFids);
    } else {
      let fids = await kv.smembers(`contest_entries:${contestId}`);
      entryFids = Array.isArray(fids) ? fids : [];
    }

    if (!entryFids || entryFids.length === 0) {
      return res.status(200).json({ participants: [], count: 0 });
    }

    // Limit to 30 participants (for display purposes)
    const limitedFids = entryFids.slice(0, 30);

    // Fetch user profiles from Neynar in bulk
    const fidsParam = limitedFids.join(',');
    const neynarResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fidsParam}`,
      {
        headers: { 'api_key': NEYNAR_API_KEY }
      }
    );

    if (!neynarResponse.ok) {
      console.error('Neynar API error:', await neynarResponse.text());
      return res.status(200).json({ participants: [], count: entryFids.length });
    }

    const neynarData = await neynarResponse.json();
    const users = neynarData.users || [];

    // Now fetch actual replies from the contest cast to determine who has replied
    const hasRepliedSet = new Set();

    try {
      // Get the cast hash from the contract
      const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
      const provider = new ethers.JsonRpcProvider(RPC_URL);

      let castId = null;

      if (isV2) {
        // V2 contest - use ContestManager V2
        const contract = new ethers.Contract(CONTEST_MANAGER_V2_ADDRESS, CONTEST_MANAGER_V2_ABI, provider);
        const contestData = await contract.getContest(contestIdNum);
        castId = contestData[3]; // castId is 4th element
      } else if (contestIdNum >= 66) {
        // NFT contest escrow
        const contract = new ethers.Contract(NFT_CONTEST_ESCROW_ADDRESS, NFT_CONTEST_ESCROW_ABI, provider);
        const contestData = await contract.getContest(contestIdNum);
        castId = contestData[7]; // castId is 8th element
      } else {
        // Original contest escrow
        const contract = new ethers.Contract(CONTEST_ESCROW_ADDRESS, CONTEST_ESCROW_ABI, provider);
        const contestData = await contract.getContest(contestIdNum);
        castId = contestData[5]; // castId is 6th element
      }

      // Extract actual cast hash (remove requirements suffix if present)
      const actualCastHash = castId && castId.includes('|') ? castId.split('|')[0] : castId;

      if (actualCastHash && actualCastHash.length > 0) {
        // Fetch replies from Neynar
        const repliesResponse = await fetch(
          `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${actualCastHash}&type=hash&reply_depth=1&limit=100`,
          {
            headers: { 'api_key': NEYNAR_API_KEY }
          }
        );

        if (repliesResponse.ok) {
          const repliesData = await repliesResponse.json();
          const replies = repliesData.conversation?.cast?.direct_replies || [];

          // Build set of FIDs who replied
          for (const reply of replies) {
            if (reply.author?.fid) {
              hasRepliedSet.add(reply.author.fid);
            }
          }
        }
      }
    } catch (replyError) {
      console.error('Error fetching replies:', replyError.message);
      // Continue without reply data - just won't show stacked PFPs
    }

    // Map to participant objects with hasReplied status
    const participants = users.map(user => ({
      fid: user.fid,
      pfpUrl: user.pfp_url || null,
      username: user.username,
      hasReplied: hasRepliedSet.has(user.fid)
    })).filter(p => p.pfpUrl); // Only include users with PFPs

    return res.status(200).json({
      participants,
      count: entryFids.length,
      displayed: participants.length
    });

  } catch (error) {
    console.error('Contest participants error:', error);
    return res.status(500).json({ error: error.message });
  }
};
