/**
 * Best Tode Finalize API (Admin only)
 *
 * POST /api/best-tode-finalize
 * Body: { seasonId: 1, adminFid: 893935 }
 *
 * Finalizes Best Tode voting and calculates final rankings.
 * Can only be called after the 48-hour voting period ends.
 *
 * Prize Distribution (calculated but distributed manually):
 *   1st: 50% of host prize pool (ETH)
 *   2nd: 35% of host prize pool (ETH)
 *   3rd: 15% of host prize pool (ETH)
 *   4th-5th: 200M NEYNARTODES each
 *   6th-10th: 100M NEYNARTODES each
 */

const ADMIN_FIDS = [3, 893935, 394128, 483571, 880094];

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { seasonId, adminFid, hostPoolETH } = req.body;

  if (!adminFid || !ADMIN_FIDS.includes(parseInt(adminFid))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!seasonId) {
    return res.status(400).json({ error: 'Missing seasonId' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    // Check if Best Tode is initialized
    const candidates = await kv.get(`best_tode:${seasonId}:candidates`);
    if (!candidates) {
      return res.status(400).json({ error: 'Best Tode not initialized for this season' });
    }

    // Check if already finalized
    const existingResults = await kv.get(`best_tode:${seasonId}:results`);
    if (existingResults) {
      return res.status(400).json({
        error: 'Already finalized',
        results: existingResults
      });
    }

    // Check if voting period has ended
    const endTime = await kv.get(`best_tode:${seasonId}:end_time`);
    const now = Math.floor(Date.now() / 1000);

    if (now < endTime) {
      const remaining = endTime - now;
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      return res.status(400).json({
        error: 'Voting period has not ended yet',
        timeRemaining: `${hours}h ${minutes}m`,
        endsAt: new Date(endTime * 1000).toISOString()
      });
    }

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

    // Sort by vote count (highest first) to determine final rankings
    // In case of tie, original leaderboard position is preserved (stable sort)
    voteCounts.sort((a, b) => b.voteCount - a.voteCount);

    // Calculate prizes
    const poolETH = parseFloat(hostPoolETH) || 0;
    const results = {
      seasonId: parseInt(seasonId),
      finalizedAt: new Date().toISOString(),
      finalizedBy: parseInt(adminFid),
      hostPoolETH: poolETH,
      rankings: voteCounts.map((candidate, index) => {
        const position = index + 1;
        let ethPrize = 0;
        let tokenPrize = 0;

        if (position === 1) ethPrize = poolETH * 0.50;
        else if (position === 2) ethPrize = poolETH * 0.35;
        else if (position === 3) ethPrize = poolETH * 0.15;

        return {
          position,
          fid: candidate.fid,
          username: candidate.username,
          pfpUrl: candidate.pfpUrl,
          address: candidate.address,
          voteCount: candidate.voteCount,
          ethPrize: ethPrize.toFixed(6),
          tokenPrize: tokenPrize
        };
      }),
      totalVotes: voteCounts.reduce((sum, c) => sum + c.voteCount, 0)
    };

    // Store results
    await kv.set(`best_tode:${seasonId}:results`, results);

    console.log(`Best Tode finalized for season ${seasonId}:`, results);

    return res.status(200).json({
      success: true,
      message: 'Best Tode voting finalized',
      results
    });

  } catch (error) {
    console.error('Error finalizing Best Tode:', error);
    return res.status(500).json({ error: 'Failed to finalize voting' });
  }
};
