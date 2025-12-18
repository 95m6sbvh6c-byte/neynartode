/**
 * Frame Callback API
 *
 * Called after a wash trade transaction is confirmed.
 * Processes the entry: like, recast, and record in KV.
 *
 * POST /api/frame-callback?contestId=30
 * Body: Farcaster Frame callback payload (includes transaction hash)
 *
 * Returns: Success frame with "Entered ✓"
 */

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://frame-opal-eight.vercel.app';

async function getUserAddresses(fid) {
  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) return [];

  const response = await fetch(
    `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
    {
      headers: { 'api_key': NEYNAR_API_KEY }
    }
  );

  if (!response.ok) return [];

  const data = await response.json();
  const user = data.users?.[0];
  if (!user) return [];

  return user.verified_addresses?.eth_addresses || [];
}

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

  const { contestId } = req.query;
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  try {
    // Parse Frame callback payload
    const { untrustedData, trustedData } = req.body;

    if (!untrustedData) {
      return res.status(400).json({ error: 'Invalid frame callback' });
    }

    const fid = untrustedData.fid;
    const castHash = untrustedData.castId?.hash;
    const transactionId = untrustedData.transactionId;

    if (!fid) {
      return res.status(400).json({ error: 'Missing fid in frame callback' });
    }

    // Transaction was confirmed (user approved), now process entry
    const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

    if (!process.env.KV_REST_API_URL) {
      return res.status(500).json({ error: 'KV storage not configured' });
    }

    const { kv } = require('@vercel/kv');

    // Get user's signer
    const signerData = await kv.get(`signer:${fid}`);

    if (signerData && signerData.approved) {
      // Post like
      await fetch('https://api.neynar.com/v2/farcaster/reaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_key': NEYNAR_API_KEY
        },
        body: JSON.stringify({
          signer_uuid: signerData.signer_uuid,
          reaction_type: 'like',
          target: castHash
        })
      }).catch(e => console.log('Like failed:', e.message));

      // Post recast
      await fetch('https://api.neynar.com/v2/farcaster/reaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_key': NEYNAR_API_KEY
        },
        body: JSON.stringify({
          signer_uuid: signerData.signer_uuid,
          reaction_type: 'recast',
          target: castHash
        })
      }).catch(e => console.log('Recast failed:', e.message));
    }

    // Get user's addresses
    const addresses = await getUserAddresses(fid);

    // Record entry
    const entry = {
      fid: parseInt(fid),
      contestId: contestId.toString(),
      addresses,
      timestamp: Date.now(),
      hasReplied: false,
      enteredAt: new Date().toISOString(),
      source: 'frame',
      washTradeTx: transactionId || null
    };

    await kv.set(`entry:${contestId}:${fid}`, entry);
    await kv.sadd(`contest_entries:${contestId}`, fid.toString());

    console.log(`Frame entry recorded for FID ${fid} in contest ${contestId}`);

    // Return success frame
    const imageUrl = `${BASE_URL}/api/frame-image?contestId=${contestId}&status=entered&t=${Date.now()}`;

    return res.status(200).json({
      type: 'frame',
      frameUrl: `${BASE_URL}/api/frame?contestId=${contestId}&status=entered`,
      image: imageUrl,
      buttons: [
        {
          label: 'Entered ✓',
          action: 'post'
        },
        {
          label: 'Reply for Bonus Entry',
          action: 'link',
          target: `https://warpcast.com/~/compose?parentUrl=${encodeURIComponent(`https://warpcast.com/${castHash}`)}`
        }
      ]
    });

  } catch (error) {
    console.error('Frame callback error:', error);
    return res.status(500).json({ error: error.message });
  }
};
