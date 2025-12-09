/**
 * Admin endpoint to clear announcement flags
 *
 * Usage:
 *   GET /api/admin-clear-announced?contestId=5&nft=true&secret=YOUR_SECRET
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Simple auth check
  const secret = req.query.secret;
  const expectedSecret = process.env.NOTIFICATION_SECRET || 'neynartodes-notif-secret';

  if (secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const contestId = req.query.contestId;
  const isNft = req.query.nft === 'true';

  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  try {
    if (!process.env.KV_REST_API_URL) {
      return res.status(500).json({ error: 'KV not configured' });
    }

    const { kv } = await import('@vercel/kv');
    const key = isNft ? `announced_nft_${contestId}` : `announced_${contestId}`;

    await kv.del(key);

    return res.status(200).json({
      success: true,
      message: `Cleared announcement flag: ${key}`,
    });

  } catch (error) {
    console.error('Error clearing flag:', error);
    return res.status(500).json({ error: error.message });
  }
};
