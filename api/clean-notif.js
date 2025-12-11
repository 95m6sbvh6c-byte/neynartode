/**
 * Clean fake notification entries
 * GET /api/clean-notif?fid=1188162
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const fid = req.query.fid;
  if (!fid) {
    return res.status(400).json({ error: 'Missing fid parameter' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(200).json({ error: 'KV not configured' });
  }

  try {
    const { kv } = await import('@vercel/kv');

    await kv.del(`notif:${fid}`);
    await kv.srem('notif:subscribers', fid.toString());

    return res.status(200).json({
      success: true,
      message: `Removed notification entry for FID ${fid}`,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
