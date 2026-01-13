/**
 * Check Shares API
 *
 * Returns which contests a user has shared.
 * Used to show "Shared ✓" status on Share buttons.
 *
 * GET /api/check-shares?fid=123&contestIds=T-9,M-1,M-2
 * Returns: { shares: { "T-9": true, "M-1": false, "M-2": true } }
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fid, contestIds } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid parameter' });
  }

  if (!contestIds) {
    return res.status(200).json({ shares: {} });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ shares: {} });
  }

  const { kv } = require('@vercel/kv');

  try {
    const contestIdList = contestIds.split(',').map(id => id.trim()).filter(id => id);
    const shares = {};

    // Check each contest in parallel
    await Promise.all(
      contestIdList.map(async (contestId) => {
        const userShareKey = `share:${contestId}:${fid}`;
        const exists = await kv.exists(userShareKey);
        shares[contestId] = exists === 1;
      })
    );

    return res.status(200).json({ shares });

  } catch (error) {
    console.error('Check shares error:', error);
    return res.status(500).json({ error: error.message });
  }
};
