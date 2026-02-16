/**
 * DAO Vote API
 *
 * POST /api/dao-vote
 * Body: { proposalId: "dao_...", fid: 12345, vote: "for"|"against" }
 *
 * Casts a weighted vote on a DAO proposal.
 * Vote weight = user's voting power (1-3 based on participation).
 * Each user can only vote once per proposal.
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { proposalId, fid, vote } = req.body;

  if (!proposalId) return res.status(400).json({ error: 'Missing proposalId' });
  if (!fid) return res.status(400).json({ error: 'Missing fid' });
  if (!vote || !['for', 'against'].includes(vote)) {
    return res.status(400).json({ error: 'Vote must be "for" or "against"' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    // Check proposal exists and is active
    const proposal = await kv.get(`dao:proposal:${proposalId}`);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (proposal.status !== 'active' || proposal.endTime <= now) {
      return res.status(400).json({ error: 'Voting has ended on this proposal' });
    }

    // Check if already voted
    const existingVote = await kv.get(`dao:vote:${proposalId}:${fid}`);
    if (existingVote) {
      return res.status(400).json({
        error: 'You have already voted on this proposal',
        alreadyVoted: true,
        vote: existingVote.vote
      });
    }

    // Get voting power
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://frame-opal-eight.vercel.app';

    const powerResponse = await fetch(`${baseUrl}/api/dao-power?fid=${fid}`);
    const powerData = await powerResponse.json();

    if (powerData.power < 1) {
      return res.status(400).json({ error: 'You must hold 100M+ NEYNARTODES to vote' });
    }

    const power = powerData.power;

    // Record the vote
    await kv.set(`dao:vote:${proposalId}:${fid}`, {
      vote,
      power,
      timestamp: now
    });

    // Update weighted counters
    if (vote === 'for') {
      await kv.incrby(`dao:votes_for:${proposalId}`, power);
    } else {
      await kv.incrby(`dao:votes_against:${proposalId}`, power);
    }

    // Add to voter set
    await kv.sadd(`dao:voters:${proposalId}`, fid.toString());

    // Update proposal object
    const votesFor = (await kv.get(`dao:votes_for:${proposalId}`)) || 0;
    const votesAgainst = (await kv.get(`dao:votes_against:${proposalId}`)) || 0;
    const voterCount = await kv.scard(`dao:voters:${proposalId}`);

    proposal.votesFor = votesFor;
    proposal.votesAgainst = votesAgainst;
    proposal.voterCount = voterCount;
    await kv.set(`dao:proposal:${proposalId}`, proposal);

    console.log(`DAO vote: FID ${fid} voted ${vote} on ${proposalId} with power ${power}`);

    return res.status(200).json({
      success: true,
      vote,
      votingPower: power,
      votesFor,
      votesAgainst,
      voterCount
    });

  } catch (error) {
    console.error('Error casting DAO vote:', error);
    return res.status(500).json({ error: 'Failed to record vote' });
  }
};
