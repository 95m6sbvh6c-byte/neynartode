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

// Max entries per contest (Chainlink VRF limit is 1000, with bonus entries we cap at 200)
const MAX_ENTRIES_PER_CONTEST = 200;

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

  const parsedFid = parseInt(fid);
  if (!fid || isNaN(parsedFid) || parsedFid <= 0) {
    return res.status(400).json({ error: 'Missing or invalid fid' });
  }
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }
  // castHash is optional - some contests may not have an associated cast
  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid addresses' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    // Check if user already entered this contest
    const existingEntry = await kv.get(`entry:${contestId}:${parsedFid}`);
    if (existingEntry) {
      return res.status(200).json({
        success: true,
        already_entered: true,
        entry: existingEntry
      });
    }

    // Check if contest has reached max entries
    const currentEntryCount = await kv.scard(`contest_entries:${contestId}`) || 0;
    if (currentEntryCount >= MAX_ENTRIES_PER_CONTEST) {
      return res.status(400).json({
        error: 'Contest has reached maximum entries (200)',
        contest_full: true,
        entry_count: currentEntryCount,
        max_entries: MAX_ENTRIES_PER_CONTEST
      });
    }

    // Record entry in KV (no signer required, no auto-like)
    const entry = {
      fid: parsedFid,
      contestId: contestId.toString(),
      castHash: castHash || null,
      addresses,
      timestamp: Date.now(),
      hasReplied: false,
      enteredAt: new Date().toISOString()
    };

    await kv.set(`entry:${contestId}:${parsedFid}`, entry);

    // Also add to contest entries set for easy lookup
    await kv.sadd(`contest_entries:${contestId}`, parsedFid.toString());

    console.log(`Entry recorded for FID ${parsedFid} in contest ${contestId}`);

    return res.status(200).json({
      success: true,
      entry
    });

  } catch (error) {
    console.error('Enter contest error:', error);
    return res.status(500).json({ error: error.message });
  }
};
