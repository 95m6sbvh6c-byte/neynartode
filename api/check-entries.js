/**
 * Check Entries API
 *
 * Returns which contests a user has entered.
 * Used to display green ✓ / red ✗ on contest cards.
 *
 * GET /api/check-entries?fid=12345
 * GET /api/check-entries?fid=12345&contestIds=30,31,32
 *
 * Returns:
 * {
 *   fid: 12345,
 *   entries: {
 *     "30": { entered: true, hasReplied: false, timestamp: 1234567890 },
 *     "31": { entered: true, hasReplied: true, timestamp: 1234567891 },
 *     "32": { entered: false }
 *   }
 * }
 */

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fid, contestIds } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  try {
    const entries = {};

    if (contestIds) {
      // Check specific contests
      const ids = contestIds.split(',').map(id => id.trim());

      // Fetch all entries in parallel
      // For V2 contests (v2-{id}), also check the legacy key format ({id}) for backwards compatibility
      const entryPromises = ids.map(async (contestId) => {
        let entry = await kv.get(`entry:${contestId}:${fid}`);

        // If not found and this is a V2 contest key (v2-{id}), try the legacy format
        if (!entry && contestId.startsWith('v2-')) {
          const legacyId = contestId.replace('v2-', '');
          entry = await kv.get(`entry:${legacyId}:${fid}`);
          if (entry) {
            console.log(`Found legacy entry for ${contestId} using key entry:${legacyId}:${fid}`);
          }
        }

        return { contestId, entry };
      });

      const results = await Promise.all(entryPromises);

      results.forEach(({ contestId, entry }) => {
        if (entry) {
          entries[contestId] = {
            entered: true,
            hasReplied: entry.hasReplied || false,
            timestamp: entry.timestamp
          };
        } else {
          entries[contestId] = { entered: false };
        }
      });

    } else {
      // Get all contests user has entered using the set
      // First, we need to find all contest entry keys for this user
      // This is less efficient but works when contestIds not provided

      // Try to scan for entries (limited approach)
      // In production, you'd want to maintain a user:fid:contests set
      // For now, return empty if no contestIds provided
      return res.status(200).json({
        fid: parseInt(fid),
        entries: {},
        note: 'Provide contestIds parameter for specific contest entry status'
      });
    }

    return res.status(200).json({
      fid: parseInt(fid),
      entries
    });

  } catch (error) {
    console.error('Check entries error:', error);
    return res.status(500).json({ error: error.message });
  }
};
