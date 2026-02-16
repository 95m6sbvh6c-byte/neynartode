/**
 * DAO Proposals API
 *
 * GET  /api/dao-proposals?status=active|all&limit=20&fid=123
 *   Lists proposals. If fid provided, includes user's vote on each.
 *
 * POST /api/dao-proposals  { fid, title, description }
 *   Creates a new proposal. Requires 100M+ holder, DAO window open, 1/day limit.
 *   Admin (FID 1188162) bypasses window + rate limit.
 *
 * Admin actions:
 *   GET /api/dao-proposals?action=open&key=ADMIN_KEY   - Open proposal window
 *   GET /api/dao-proposals?action=close&key=ADMIN_KEY  - Close proposal window
 */

const { getUserByFid } = require('./lib/utils');

const ADMIN_FIDS = [1188162]; // brianwharton
const ADMIN_KEY = process.env.ADMIN_KEY || 'neynartodes-admin';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  // ─── Admin Actions ───────────────────────────────────────────────
  if (req.method === 'GET' && req.query.action) {
    const { action, key } = req.query;

    if (key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (action === 'open') {
      await kv.set('dao:open', 'true');
      return res.status(200).json({ success: true, daoOpen: true });
    }

    if (action === 'close') {
      await kv.set('dao:open', 'false');
      return res.status(200).json({ success: true, daoOpen: false });
    }

    return res.status(400).json({ error: 'Invalid action. Use open or close.' });
  }

  // ─── GET: List Proposals ─────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const status = req.query.status || 'all';
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const fid = req.query.fid ? parseInt(req.query.fid) : null;

      // Check if DAO window is open
      const daoOpen = (await kv.get('dao:open')) === 'true';

      // Get proposal IDs (newest first)
      const proposalIds = await kv.zrange('dao:proposals', 0, -1, { rev: true });

      if (!proposalIds || proposalIds.length === 0) {
        return res.status(200).json({ proposals: [], total: 0, daoOpen });
      }

      const now = Math.floor(Date.now() / 1000);
      const proposals = [];

      for (const id of proposalIds) {
        if (proposals.length >= limit) break;

        const proposal = await kv.get(`dao:proposal:${id}`);
        if (!proposal) continue;

        // Auto-resolve expired proposals
        if (proposal.status === 'active' && proposal.endTime <= now) {
          proposal.status = proposal.votesFor > proposal.votesAgainst ? 'passed' : 'rejected';
          await kv.set(`dao:proposal:${id}`, proposal);
        }

        // Filter by status
        if (status === 'active' && proposal.status !== 'active') continue;

        // If fid provided, check user's vote
        if (fid) {
          const userVote = await kv.get(`dao:vote:${id}:${fid}`);
          proposal.userVote = userVote ? userVote.vote : null;
          proposal.userPower = userVote ? userVote.power : null;
        }

        proposals.push(proposal);
      }

      return res.status(200).json({ proposals, total: proposals.length, daoOpen });

    } catch (error) {
      console.error('Error listing proposals:', error);
      return res.status(500).json({ error: 'Failed to list proposals' });
    }
  }

  // ─── POST: Create Proposal ───────────────────────────────────────
  if (req.method === 'POST') {
    const { fid, title, description } = req.body;

    if (!fid) return res.status(400).json({ error: 'Missing fid' });
    if (!title || title.length < 5 || title.length > 100) {
      return res.status(400).json({ error: 'Title must be 5-100 characters' });
    }
    if (!description || description.length < 10 || description.length > 1000) {
      return res.status(400).json({ error: 'Description must be 10-1000 characters' });
    }

    const isAdmin = ADMIN_FIDS.includes(parseInt(fid));

    try {
      // Check DAO window (admin bypasses)
      if (!isAdmin) {
        const daoOpen = (await kv.get('dao:open')) === 'true';
        if (!daoOpen) {
          return res.status(400).json({ error: 'The DAO is not currently accepting proposals' });
        }

        // Rate limit: 1 proposal per 24 hours (admin bypasses)
        const lastProposal = await kv.get(`dao:last_proposal:${fid}`);
        if (lastProposal) {
          return res.status(400).json({ error: 'You can only create 1 proposal per 24 hours' });
        }
      }

      // Check holder status via dao-power endpoint
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://frame-opal-eight.vercel.app';

      const powerResponse = await fetch(`${baseUrl}/api/dao-power?fid=${fid}`);
      const powerData = await powerResponse.json();

      if (!isAdmin && powerData.power < 1) {
        return res.status(400).json({ error: 'You must hold 100M+ NEYNARTODES to create proposals' });
      }

      // Get user info for display
      const user = await getUserByFid(parseInt(fid));
      const username = user?.username || `FID:${fid}`;
      const pfpUrl = user?.pfp_url || '';

      // Create proposal
      const now = Math.floor(Date.now() / 1000);
      const proposalId = `dao_${now}_${fid}`;

      const proposal = {
        id: proposalId,
        title: title.trim(),
        description: description.trim(),
        creatorFid: parseInt(fid),
        creatorUsername: username,
        creatorPfpUrl: pfpUrl,
        createdAt: now,
        endTime: now + 172800, // 48 hours
        status: 'active',
        votesFor: 0,
        votesAgainst: 0,
        voterCount: 0
      };

      // Store proposal
      await kv.set(`dao:proposal:${proposalId}`, proposal);
      await kv.zadd('dao:proposals', { score: now, member: proposalId });

      // Rate limit (admin bypasses)
      if (!isAdmin) {
        await kv.set(`dao:last_proposal:${fid}`, true, { ex: 86400 }); // 24hr TTL
      }

      console.log(`DAO proposal created: "${title}" by @${username} (FID ${fid})`);

      return res.status(200).json({ success: true, proposal });

    } catch (error) {
      console.error('Error creating proposal:', error);
      return res.status(500).json({ error: 'Failed to create proposal' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
