/**
 * Enter Contest API
 *
 * Handles the "Enter Raffle" button action:
 * 1. Posts like to contest cast via Neynar
 * 2. Records entry in KV storage
 *
 * Called AFTER wallet transaction succeeds (for non-holders)
 * or directly (for holders who don't need wash trade).
 *
 * POST /api/enter-contest
 * Body: {
 *   fid: 12345,
 *   contestId: "30",
 *   castHash: "0xabc123...",
 *   addresses: ["0x..."]
 * }
 *
 * Returns: { success: true, entry: { ... } }
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

  const { fid, contestId, castHash, addresses } = req.body;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }
  if (!castHash) {
    return res.status(400).json({ error: 'Missing castHash' });
  }
  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid addresses' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) {
    return res.status(500).json({ error: 'Neynar API key not configured' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    // Check if user already entered this contest
    const existingEntry = await kv.get(`entry:${contestId}:${fid}`);
    if (existingEntry) {
      return res.status(200).json({
        success: true,
        already_entered: true,
        entry: existingEntry
      });
    }

    // Get user's signer
    const signerData = await kv.get(`signer:${fid}`);
    if (!signerData || !signerData.approved) {
      return res.status(400).json({
        error: 'No approved signer for this user',
        needs_signer: true
      });
    }

    const signer_uuid = signerData.signer_uuid;

    // Post like via Neynar API
    const likeResponse = await fetch('https://api.neynar.com/v2/farcaster/reaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      },
      body: JSON.stringify({
        signer_uuid,
        reaction_type: 'like',
        target: castHash
      })
    });

    if (!likeResponse.ok) {
      const errorData = await likeResponse.json().catch(() => ({}));
      // Don't fail if already liked
      if (!errorData.message?.includes('already')) {
        console.error('Like failed:', errorData);
        return res.status(500).json({
          error: 'Failed to post like',
          details: errorData.message || likeResponse.statusText
        });
      }
    }

    // Record entry in KV
    const entry = {
      fid: parseInt(fid),
      contestId: contestId.toString(),
      addresses,
      timestamp: Date.now(),
      hasReplied: false,
      enteredAt: new Date().toISOString()
    };

    await kv.set(`entry:${contestId}:${fid}`, entry);

    // Also add to contest entries set for easy lookup
    await kv.sadd(`contest_entries:${contestId}`, fid.toString());

    console.log(`Entry recorded for FID ${fid} in contest ${contestId}`);

    return res.status(200).json({
      success: true,
      entry
    });

  } catch (error) {
    console.error('Enter contest error:', error);
    return res.status(500).json({ error: error.message });
  }
};
