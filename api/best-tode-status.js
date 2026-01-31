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

const ADMIN_FIDS = [1891537, 1188162];

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

        // 48 hour voting period
        const endTime = Math.floor(Date.now() / 1000) + (48 * 60 * 60);

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

      // Reset Best Tode data for a season
      if (action === 'reset') {
        // Get candidates to know which vote sets to delete
        const existingCandidates = await kv.get(`best_tode:${seasonId}:candidates`);

        // Delete all Best Tode keys for this season
        const keysToDelete = [
          `best_tode:${seasonId}:candidates`,
          `best_tode:${seasonId}:end_time`,
          `best_tode:${seasonId}:results`,
          `best_tode:${seasonId}:distributed`
        ];

        // Delete vote sets for each candidate
        if (existingCandidates && Array.isArray(existingCandidates)) {
          for (const candidate of existingCandidates) {
            keysToDelete.push(`best_tode:${seasonId}:votes:${candidate.fid}`);
          }
        }

        // Delete all keys (kv.del returns number of keys deleted)
        let deleted = 0;
        for (const key of keysToDelete) {
          try {
            await kv.del(key);
            deleted++;
          } catch (e) {
            // Key might not exist, that's ok
          }
        }

        // Note: voted:{fid} keys are not deleted here as we don't track all voters
        // They will naturally become irrelevant when a new Best Tode starts

        console.log(`Best Tode reset for season ${seasonId}, deleted ${deleted} keys`);

        return res.status(200).json({
          success: true,
          message: 'Best Tode data cleared',
          seasonId: parseInt(seasonId),
          keysDeleted: deleted
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
