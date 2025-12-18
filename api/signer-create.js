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

      // If there's a pending signer, return it
      if (existingSigner && !existingSigner.approved) {
        // Check if it's still valid (less than 24 hours old)
        const age = Date.now() - existingSigner.created_at;
        if (age < 24 * 60 * 60 * 1000) {
          return res.status(200).json({
            success: true,
            pending: true,
            signer_uuid: existingSigner.signer_uuid,
            approval_url: existingSigner.approval_url,
            fid
          });
        }
      }
    }

    // Create a new signer via Neynar API
    const response = await fetch('https://api.neynar.com/v2/farcaster/signer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': NEYNAR_API_KEY
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Neynar signer creation failed:', errorData);
      return res.status(500).json({
        error: 'Failed to create signer',
        details: errorData.message || response.statusText
      });
    }

    const signerData = await response.json();

    // The signer needs to be registered with Neynar to get approval URL
    // Use the signed key request endpoint
    const registerResponse = await fetch('https://api.neynar.com/v2/farcaster/signer/signed_key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': NEYNAR_API_KEY
      },
      body: JSON.stringify({
        signer_uuid: signerData.signer_uuid,
        app_fid: parseInt(process.env.APP_FID || '0'),
        deadline: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour deadline
      })
    });

    if (!registerResponse.ok) {
      const errorData = await registerResponse.json().catch(() => ({}));
      console.error('Neynar signed key registration failed:', errorData);
      return res.status(500).json({
        error: 'Failed to register signer',
        details: errorData.message || registerResponse.statusText
      });
    }

    const registeredData = await registerResponse.json();

    // The approval URL is in the signer_approval_url field
    const approval_url = registeredData.signer_approval_url ||
                         `https://client.warpcast.com/deeplinks/signed-key-request?token=${signerData.signer_uuid}`;

    // Store in KV
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      await kv.set(`signer:${fid}`, {
        signer_uuid: signerData.signer_uuid,
        public_key: signerData.public_key,
        approval_url,
        approved: false,
        created_at: Date.now()
      });
    }

    console.log(`Created signer for FID ${fid}:`, signerData.signer_uuid);

    return res.status(200).json({
      success: true,
      signer_uuid: signerData.signer_uuid,
      approval_url,
      fid
    });

  } catch (error) {
    console.error('Signer creation error:', error);
    return res.status(500).json({ error: error.message });
  }
};
