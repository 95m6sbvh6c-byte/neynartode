/**
 * Contest Participants API (Simplified)
 *
 * Returns participant profile pictures for a contest.
 * Used to display floating PFPs in the active contests section.
 *
 * GET /api/contest-participants?contestId=M-1
 * Returns: { participants: [{ fid, pfpUrl, username }], count, displayed }
 *
 * Note: Bonus calculations (holder, share, volume) only happen at finalization.
 * This endpoint just shows who entered.
 */

const { getUsersByFids } = require('./lib/utils');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contestId, limit } = req.query;

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId parameter' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ participants: [], count: 0, error: 'KV not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Get all FIDs who entered this contest
    let entryFids = await kv.smembers(`contest_entries:${contestId}`);
    entryFids = Array.isArray(entryFids) ? entryFids : [];

    const totalCount = entryFids.length;

    if (totalCount === 0) {
      return res.status(200).json({ participants: [], count: 0, displayed: 0 });
    }

    // Default limit is 30 for PFP display, but allow fetching more for popup
    const displayLimit = limit ? Math.min(parseInt(limit), 200) : 30;
    const limitedFids = entryFids.slice(0, displayLimit);

    // Fetch user profiles from Neynar in bulk (cached)
    const users = await getUsersByFids(limitedFids.map(f => parseInt(f)));

    if (!users || users.length === 0) {
      return res.status(200).json({ participants: [], count: totalCount, displayed: 0 });
    }

    // Map to simple participant objects
    const participants = users
      .map(user => ({
        fid: user.fid,
        pfpUrl: user.pfp_url || null,
        username: user.username,
        displayName: user.display_name || user.username
      }))
      .filter(p => p.pfpUrl); // Only include users with PFPs

    return res.status(200).json({
      participants,
      count: totalCount,
      displayed: participants.length,
      hasMore: totalCount > displayLimit
    });

  } catch (error) {
    console.error('Contest participants error:', error);
    return res.status(500).json({ error: error.message });
  }
};
