/**
 * Debug KV API - TEMPORARY
 * Check what's stored in KV for a contest
 *
 * GET /api/debug-kv?contestId=112
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const { contestId } = req.query;

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Check all possible key formats
    const keys = [
      `contest_entries:${contestId}`,
      `contest_entries:v2-${contestId}`,
    ];

    const results = {};

    for (const key of keys) {
      const members = await kv.smembers(key);
      results[key] = {
        exists: members !== null,
        count: Array.isArray(members) ? members.length : 0,
        members: Array.isArray(members) ? members.slice(0, 10) : members
      };
    }

    // Also check a sample entry key
    const sampleEntryKeys = [
      `entry:${contestId}:1188162`,
      `entry:v2-${contestId}:1188162`,
    ];

    for (const key of sampleEntryKeys) {
      const entry = await kv.get(key);
      results[key] = entry ? 'EXISTS' : 'NOT FOUND';
    }

    return res.status(200).json({
      contestId,
      results
    });

  } catch (error) {
    console.error('Debug KV error:', error);
    return res.status(500).json({ error: error.message });
  }
};
