/**
 * Debug Notifications - Check subscribers in KV
 * GET /api/debug-notif
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ error: 'KV not configured' });
  }

  try {
    const { kv } = await import('@vercel/kv');

    // Get all subscriber FIDs
    const fids = await kv.smembers('notif:subscribers');

    // Get details for each
    const subscribers = [];
    for (const fid of fids) {
      const data = await kv.hgetall(`notif:${fid}`);
      subscribers.push({
        fid,
        ...data,
        token: data?.token ? data.token.slice(0, 20) + '...' : null,
      });
    }

    return res.status(200).json({
      totalSubscribers: fids.length,
      subscribers,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
