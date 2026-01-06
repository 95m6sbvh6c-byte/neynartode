/**
 * Record Share API
 *
 * Records when a user clicks the Share button on a contest.
 * This gives them a bonus entry in the raffle.
 *
 * POST /api/record-share
 * Body: { fid: number, contestId: string }
 *
 * Returns: { success: true, shared: true } or { success: true, alreadyShared: true }
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

  const { fid, contestId } = req.body;

  // Validate inputs
  if (!fid || !contestId) {
    return res.status(400).json({ error: 'Missing fid or contestId' });
  }

  // Validate contest ID format (must be M-X or T-X)
  if (!contestId.startsWith('M-') && !contestId.startsWith('T-')) {
    return res.status(400).json({ error: 'Invalid contestId format. Use M-X or T-X' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    const shareKey = `contest_shares:${contestId}`;
    const userShareKey = `share:${contestId}:${fid}`;

    // Check if user already shared
    const existingShare = await kv.get(userShareKey);
    if (existingShare) {
      return res.status(200).json({
        success: true,
        alreadyShared: true,
        message: 'You already shared this contest'
      });
    }

    // Record the share
    const shareData = {
      fid: parseInt(fid),
      contestId,
      timestamp: Date.now()
    };

    // Store individual share record
    await kv.set(userShareKey, shareData);

    // Add FID to contest shares set (for finalization lookup)
    await kv.sadd(shareKey, fid.toString());

    console.log(`Share recorded: FID ${fid} shared contest ${contestId}`);

    return res.status(200).json({
      success: true,
      shared: true,
      message: 'Share recorded! You earned a bonus entry.'
    });

  } catch (error) {
    console.error('Record share error:', error);
    return res.status(500).json({ error: error.message });
  }
};
