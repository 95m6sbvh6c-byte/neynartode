/**
 * Contest Participants API
 *
 * Returns participant profile pictures for a contest.
 * Used to display floating PFPs in the active contests section.
 *
 * GET /api/contest-participants?contestId=112
 * Returns: { participants: [{ fid, pfpUrl, username }] }
 */

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
    // Check both key formats: v2-{id} (new) and {id} (legacy) for V2 contests
    const V2_START_ID = 105;
    const contestIdNum = parseInt(contestId);
    const isV2 = contestIdNum >= V2_START_ID;

    let entryFids = [];

    if (isV2) {
      // Try V2 format first
      entryFids = await kv.smembers(`contest_entries:v2-${contestId}`);
      // If empty, try legacy format
      if (!entryFids || entryFids.length === 0) {
        entryFids = await kv.smembers(`contest_entries:${contestId}`);
      }
    } else {
      entryFids = await kv.smembers(`contest_entries:${contestId}`);
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

    // Map to simple participant objects
    const participants = users.map(user => ({
      fid: user.fid,
      pfpUrl: user.pfp_url || null,
      username: user.username
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
