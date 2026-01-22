/**
 * Best Tode Vote API
 *
 * POST /api/best-tode-vote
 * Body: { seasonId: 1, voterFid: 12345, candidateFid: 67890 }
 *
 * Casts a vote for a candidate in the Best Tode voting round.
 * Each user can only vote once per season.
 * Votes cannot be cast after the 48-hour voting period ends.
 */

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

  const { seasonId, voterFid, candidateFid } = req.body;

  if (!seasonId) {
    return res.status(400).json({ error: 'Missing seasonId' });
  }
  if (!voterFid) {
    return res.status(400).json({ error: 'Missing voterFid' });
  }
  if (!candidateFid) {
    return res.status(400).json({ error: 'Missing candidateFid' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    // Check if Best Tode is initialized for this season
    const candidates = await kv.get(`best_tode:${seasonId}:candidates`);
    if (!candidates) {
      return res.status(400).json({ error: 'Best Tode voting not active for this season' });
    }

    // Check if voting period has ended (CRITICAL - enforce 48 hour limit)
    const endTime = await kv.get(`best_tode:${seasonId}:end_time`);
    const now = Math.floor(Date.now() / 1000);

    if (now >= endTime) {
      return res.status(400).json({
        error: 'Voting period has ended',
        votingEnded: true,
        endedAt: new Date(endTime * 1000).toISOString()
      });
    }

    // Check if results are already finalized
    const results = await kv.get(`best_tode:${seasonId}:results`);
    if (results) {
      return res.status(400).json({ error: 'Voting has been finalized' });
    }

    // Check if candidate is valid
    const validCandidate = candidates.find(c => c.fid === parseInt(candidateFid));
    if (!validCandidate) {
      return res.status(400).json({ error: 'Invalid candidate' });
    }

    // Check if user has already voted (1 vote per user per season)
    const existingVote = await kv.get(`best_tode:${seasonId}:voted:${voterFid}`);
    if (existingVote) {
      return res.status(400).json({
        error: 'You have already voted',
        alreadyVoted: true,
        votedFor: existingVote
      });
    }

    // Record the vote
    // 1. Add voter to candidate's vote set
    await kv.sadd(`best_tode:${seasonId}:votes:${candidateFid}`, voterFid.toString());

    // 2. Record who the voter voted for (to prevent double voting)
    await kv.set(`best_tode:${seasonId}:voted:${voterFid}`, parseInt(candidateFid));

    // Get updated vote count for response
    const voteCount = await kv.scard(`best_tode:${seasonId}:votes:${candidateFid}`);

    console.log(`Best Tode vote: FID ${voterFid} voted for FID ${candidateFid} in season ${seasonId}`);

    return res.status(200).json({
      success: true,
      message: 'Vote recorded',
      seasonId: parseInt(seasonId),
      voterFid: parseInt(voterFid),
      votedFor: {
        fid: validCandidate.fid,
        username: validCandidate.username,
        voteCount
      }
    });

  } catch (error) {
    console.error('Error casting Best Tode vote:', error);
    return res.status(500).json({ error: 'Failed to record vote' });
  }
};
