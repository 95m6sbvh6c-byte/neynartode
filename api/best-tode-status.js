/**
 * Best Tode Status API
 *
 * GET /api/best-tode-status?seasonId=1
 *   Returns current Best Tode voting status
 *
 * GET /api/best-tode-status?seasonId=1&fid=12345
 *   Also returns if this user has voted
 *
 * POST /api/best-tode-status (Admin only)
 *   Body: { action: "start", seasonId: 1, candidates: [{fid, username, pfpUrl, address}] }
 *   Initializes Best Tode voting for a season
 */

const ADMIN_FIDS = [3, 893935, 394128, 483571, 880094];

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  // GET - Fetch status
  if (req.method === 'GET') {
    const { seasonId, fid } = req.query;

    if (!seasonId) {
      return res.status(400).json({ error: 'Missing seasonId' });
    }

    try {
      // Get Best Tode data for this season
      const candidates = await kv.get(`best_tode:${seasonId}:candidates`);
      const endTime = await kv.get(`best_tode:${seasonId}:end_time`);
      const results = await kv.get(`best_tode:${seasonId}:results`);
      const distributed = await kv.get(`best_tode:${seasonId}:distributed`);

      // Not initialized
      if (!candidates || !endTime) {
        return res.status(200).json({
          active: false,
          initialized: false,
          seasonId: parseInt(seasonId)
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const votingEnded = now >= endTime;
      const active = !votingEnded && !results;

      // Get vote counts for each candidate
      const voteCounts = await Promise.all(
        candidates.map(async (candidate) => {
          const count = await kv.scard(`best_tode:${seasonId}:votes:${candidate.fid}`);
          return {
            ...candidate,
            voteCount: count || 0
          };
        })
      );

      // Sort by vote count for display
      voteCounts.sort((a, b) => b.voteCount - a.voteCount);

      // Check if user has voted
      let userVote = null;
      if (fid) {
        userVote = await kv.get(`best_tode:${seasonId}:voted:${fid}`);
      }

      return res.status(200).json({
        active,
        initialized: true,
        seasonId: parseInt(seasonId),
        candidates: voteCounts,
        endTime,
        votingEnded,
        userVote,
        results: results || null,
        distributed: distributed || false,
        timeRemaining: votingEnded ? 0 : endTime - now
      });

    } catch (error) {
      console.error('Error fetching Best Tode status:', error);
      return res.status(500).json({ error: 'Failed to fetch status' });
    }
  }

  // POST - Admin actions (start voting, finalize)
  if (req.method === 'POST') {
    const { action, seasonId, candidates, adminFid } = req.body;

    if (!adminFid || !ADMIN_FIDS.includes(parseInt(adminFid))) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!seasonId) {
      return res.status(400).json({ error: 'Missing seasonId' });
    }

    try {
      // Start voting
      if (action === 'start') {
        if (!candidates || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
          return res.status(400).json({ error: 'Must provide 1-3 candidates' });
        }

        // Check if already initialized
        const existing = await kv.get(`best_tode:${seasonId}:candidates`);
        if (existing) {
          return res.status(400).json({ error: 'Best Tode already initialized for this season' });
        }

        // Set 10 minute voting period for testing (change to 48 * 60 * 60 for production)
        const endTime = Math.floor(Date.now() / 1000) + (10 * 60);

        await kv.set(`best_tode:${seasonId}:candidates`, candidates);
        await kv.set(`best_tode:${seasonId}:end_time`, endTime);

        console.log(`Best Tode voting started for season ${seasonId}, ends at ${new Date(endTime * 1000).toISOString()}`);

        return res.status(200).json({
          success: true,
          message: 'Best Tode voting started',
          seasonId: parseInt(seasonId),
          candidates,
          endTime,
          endsAt: new Date(endTime * 1000).toISOString()
        });
      }

      return res.status(400).json({ error: 'Invalid action' });

    } catch (error) {
      console.error('Error in Best Tode admin action:', error);
      return res.status(500).json({ error: 'Admin action failed' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
