/**
 * Signer Clear API
 *
 * Clears stale signer data for a user so they can re-authorize.
 *
 * DELETE /api/signer-clear?fid=12345
 */

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { fid } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Get existing signer data for logging
    const existingSigner = await kv.get(`signer:${fid}`);

    if (!existingSigner) {
      return res.status(200).json({
        success: true,
        message: 'No signer data found for this FID',
        fid: parseInt(fid)
      });
    }

    // Delete the signer
    await kv.del(`signer:${fid}`);

    console.log(`Cleared signer for FID ${fid}:`, existingSigner);

    return res.status(200).json({
      success: true,
      message: 'Signer data cleared',
      fid: parseInt(fid),
      cleared: {
        signer_uuid: existingSigner.signer_uuid,
        was_approved: existingSigner.approved,
        approval_url: existingSigner.approval_url
      }
    });

  } catch (error) {
    console.error('Signer clear error:', error);
    return res.status(500).json({ error: error.message });
  }
};
