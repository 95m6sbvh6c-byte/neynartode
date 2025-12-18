/**
 * Entry Clear API
 *
 * Clears raffle entries for a user so they can test again.
 *
 * DELETE /api/entry-clear?fid=12345
 *
 * Optional: Add contestId param to only clear specific contest
 * DELETE /api/entry-clear?fid=12345&contestId=30
 */

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { fid, contestId } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');
    const clearedEntries = [];

    // If specific contestId provided, only clear that one
    if (contestId) {
      const existingEntry = await kv.get(`entry:${contestId}:${fid}`);

      if (existingEntry) {
        await kv.del(`entry:${contestId}:${fid}`);
        await kv.srem(`contest_entries:${contestId}`, fid.toString());
        clearedEntries.push({ contestId, entry: existingEntry });
        console.log(`Cleared entry for FID ${fid} in contest ${contestId}`);
      }

      return res.status(200).json({
        success: true,
        message: existingEntry ? 'Entry cleared' : 'No entry found for this contest',
        fid: parseInt(fid),
        contestId,
        cleared: clearedEntries
      });
    }

    // Otherwise, scan for all entries for this FID
    // Check contests with various key formats
    const contestIdsToCheck = [];

    // V1 token contests (1-200)
    for (let i = 1; i <= 200; i++) {
      contestIdsToCheck.push(i.toString());
    }

    // V2 contests - check both uppercase and lowercase prefixes (1-200)
    for (let i = 1; i <= 200; i++) {
      contestIdsToCheck.push(`V2-${i}`);  // Uppercase
      contestIdsToCheck.push(`v2-${i}`);  // Lowercase
    }

    // NFT contests (1-100)
    for (let i = 1; i <= 100; i++) {
      contestIdsToCheck.push(`NFT-${i}`);
      contestIdsToCheck.push(`nft-${i}`);
    }

    for (const cid of contestIdsToCheck) {
      const existingEntry = await kv.get(`entry:${cid}:${fid}`);

      if (existingEntry) {
        await kv.del(`entry:${cid}:${fid}`);
        await kv.srem(`contest_entries:${cid}`, fid.toString());
        clearedEntries.push({ contestId: cid, entry: existingEntry });
        console.log(`Cleared entry for FID ${fid} in contest ${cid}`);
      }
    }

    return res.status(200).json({
      success: true,
      message: clearedEntries.length > 0
        ? `Cleared ${clearedEntries.length} entries`
        : 'No entries found for this FID',
      fid: parseInt(fid),
      entriesCleared: clearedEntries.length,
      cleared: clearedEntries
    });

  } catch (error) {
    console.error('Entry clear error:', error);
    return res.status(500).json({ error: error.message });
  }
};
