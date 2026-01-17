/**
 * Enter Contest API
 *
 * Handles the "Enter Raffle" button action:
 * Records entry in KV storage
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

    // Record entry in KV (no signer required, no auto-like)
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
