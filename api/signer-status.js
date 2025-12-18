/**
 * Signer Status API
 *
 * Checks if a user has approved their Neynar managed signer.
 * Polls Neynar API and updates KV storage when approved.
 *
 * GET /api/signer-status?fid=12345
 *
 * Returns:
 *   { fid: 12345, has_signer: false } - No signer created
 *   { fid: 12345, has_signer: true, approved: false, approval_url: "..." } - Pending approval
 *   { fid: 12345, has_signer: true, approved: true, signer_uuid: "..." } - Ready to use
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

  const { fid } = req.query;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) {
    return res.status(500).json({ error: 'Neynar API key not configured' });
  }

  try {
    // Check KV for stored signer
    if (!process.env.KV_REST_API_URL) {
      return res.status(500).json({ error: 'KV storage not configured' });
    }

    const { kv } = require('@vercel/kv');
    const signerData = await kv.get(`signer:${fid}`);

    if (!signerData) {
      return res.status(200).json({
        fid: parseInt(fid),
        has_signer: false
      });
    }

    // If already marked as approved, return immediately
    if (signerData.approved) {
      return res.status(200).json({
        fid: parseInt(fid),
        has_signer: true,
        approved: true,
        signer_uuid: signerData.signer_uuid
      });
    }

    // Check with Neynar API if signer is now approved
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/signer?signer_uuid=${signerData.signer_uuid}`,
      {
        method: 'GET',
        headers: {
          'api_key': NEYNAR_API_KEY
        }
      }
    );

    if (!response.ok) {
      // If signer not found or error, return pending status
      console.error('Neynar signer check failed:', response.status);
      return res.status(200).json({
        fid: parseInt(fid),
        has_signer: true,
        approved: false,
        approval_url: signerData.approval_url
      });
    }

    const neynarData = await response.json();

    // Check if signer is now approved (status = 'approved' or has fid set)
    const isApproved = neynarData.status === 'approved' ||
                       (neynarData.fid && neynarData.fid === parseInt(fid));

    if (isApproved) {
      // Update KV storage to mark as approved
      await kv.set(`signer:${fid}`, {
        ...signerData,
        approved: true,
        approved_at: Date.now()
      });

      console.log(`Signer approved for FID ${fid}`);

      return res.status(200).json({
        fid: parseInt(fid),
        has_signer: true,
        approved: true,
        signer_uuid: signerData.signer_uuid
      });
    }

    // Still pending
    return res.status(200).json({
      fid: parseInt(fid),
      has_signer: true,
      approved: false,
      approval_url: signerData.approval_url,
      status: neynarData.status || 'pending'
    });

  } catch (error) {
    console.error('Signer status error:', error);
    return res.status(500).json({ error: error.message });
  }
};
