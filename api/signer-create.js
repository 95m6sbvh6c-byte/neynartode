/**
 * Signer Create API
 *
 * Creates a Neynar managed signer for a user.
 * The user must then approve the signer via the returned URL.
 *
 * POST /api/signer-create
 * Body: { fid: 12345 }
 *
 * Returns: { success: true, signer_uuid: "...", approval_url: "...", fid: 12345 }
 */

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

  const { fid } = req.body;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) {
    return res.status(500).json({ error: 'Neynar API key not configured' });
  }

  try {
    // Check if user already has an approved signer
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const existingSigner = await kv.get(`signer:${fid}`);

      if (existingSigner && existingSigner.approved) {
        return res.status(200).json({
          success: true,
          already_approved: true,
          signer_uuid: existingSigner.signer_uuid,
          fid
        });
      }

      // If there's a pending signer, check if it's valid
      if (existingSigner && !existingSigner.approved) {
        // Check if it's still valid (less than 24 hours old) and has a valid URL format
        const age = Date.now() - existingSigner.created_at;
        const hasValidUrl = existingSigner.approval_url &&
          !existingSigner.approval_url.includes('farcaster://') &&
          !existingSigner.approval_url.includes('client.warpcast.com/deeplinks');

        if (age < 24 * 60 * 60 * 1000 && hasValidUrl) {
          return res.status(200).json({
            success: true,
            pending: true,
            signer_uuid: existingSigner.signer_uuid,
            approval_url: existingSigner.approval_url,
            fid
          });
        }

        // Old signer has invalid URL format or is expired - delete it and create new one
        console.log(`Removing stale/invalid signer for FID ${fid}`);
        await kv.del(`signer:${fid}`);
      }
    }

    // Create a Neynar signer - the API returns signer_uuid and approval URL
    console.log(`Creating signer for FID ${fid}, API key prefix: ${NEYNAR_API_KEY.slice(0, 8)}...`);

    const createResponse = await fetch('https://api.neynar.com/v2/farcaster/signer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      }
    });

    const responseText = await createResponse.text();
    console.log('Neynar signer response status:', createResponse.status);
    console.log('Neynar signer response:', responseText);

    if (!createResponse.ok) {
      let errorData = {};
      try {
        errorData = JSON.parse(responseText);
      } catch (e) {
        errorData = { raw: responseText };
      }
      console.error('Signer creation failed:', errorData);
      return res.status(500).json({
        error: 'Failed to create signer',
        details: errorData.message || errorData.error || responseText || createResponse.statusText,
        status: createResponse.status
      });
    }

    const signerData = JSON.parse(responseText);
    console.log('Created signer:', JSON.stringify(signerData, null, 2));

    // Neynar returns signer_approval_url for user to approve in Warpcast
    // Use web URL format (not deep link) for browser compatibility
    const approval_url = signerData.signer_approval_url ||
      `https://warpcast.com/~/sign-in-with-farcaster?channelToken=${signerData.signer_uuid}`;
    const isApproved = signerData.status === 'approved';

    // Log what Neynar returned for debugging
    console.log('Neynar returned approval_url:', signerData.signer_approval_url);
    console.log('Using approval_url:', approval_url);

    console.log('Approval URL:', approval_url);
    console.log('Is approved:', isApproved);

    // Store in KV
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      await kv.set(`signer:${fid}`, {
        signer_uuid: signerData.signer_uuid,
        public_key: signerData.public_key,
        approval_url,
        approved: isApproved,
        created_at: Date.now()
      });
    }

    console.log(`Created managed signer for FID ${fid}:`, signerData.signer_uuid, 'approved:', isApproved);

    return res.status(200).json({
      success: true,
      signer_uuid: signerData.signer_uuid,
      approval_url,
      already_approved: isApproved,
      fid
    });

  } catch (error) {
    console.error('Signer creation error:', error);
    return res.status(500).json({ error: error.message });
  }
};
