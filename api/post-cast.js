/**
 * Post Cast API
 *
 * Posts a cast on behalf of a user using their approved Neynar signer.
 * Used for auto-posting contest announcements when a host creates a contest.
 *
 * POST /api/post-cast
 * Body: {
 *   fid: 12345,                    // User's Farcaster ID
 *   text: "Cast text...",          // The cast content
 *   quoteCastHash: "0x...",        // Optional: cast hash to quote
 *   embedUrls: ["https://..."],    // Optional: additional embed URLs (images, mini app)
 *   replyTo: "0x..."               // Optional: cast hash to reply to
 * }
 *
 * Returns:
 *   { success: true, castHash: "0x..." }
 *   { success: false, error: "..." }
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

  const { fid, text, quoteCastHash, embedUrls, replyTo } = req.body;

  if (!fid) {
    return res.status(400).json({ success: false, error: 'Missing fid' });
  }

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Missing cast text' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) {
    return res.status(500).json({ success: false, error: 'Neynar API key not configured' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ success: false, error: 'KV storage not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Get user's signer from KV
    const signerData = await kv.get(`signer:${fid}`);

    if (!signerData || !signerData.approved || !signerData.signer_uuid) {
      return res.status(400).json({
        success: false,
        error: 'No approved signer for this user. User must authorize the app first.'
      });
    }

    // Build embeds array
    const embeds = [];

    // Add quote cast if provided (as Warpcast URL)
    if (quoteCastHash) {
      const cleanHash = quoteCastHash.split('|')[0]; // Strip any encoded requirements
      embeds.push({ url: `https://warpcast.com/~/conversations/${cleanHash}` });
    }

    // Add additional embed URLs (images, mini app link, etc.)
    if (embedUrls && Array.isArray(embedUrls)) {
      for (const url of embedUrls) {
        if (url && typeof url === 'string') {
          embeds.push({ url });
        }
      }
    }

    // Build cast body
    const castBody = {
      signer_uuid: signerData.signer_uuid,
      text: text.trim()
    };

    // Add embeds if any
    if (embeds.length > 0) {
      castBody.embeds = embeds;
    }

    // Add reply parent if provided
    if (replyTo) {
      castBody.parent = replyTo;
    }

    console.log(`📣 Posting cast for FID ${fid}:`, {
      textLength: text.length,
      embedsCount: embeds.length,
      hasQuote: !!quoteCastHash,
      isReply: !!replyTo
    });

    // Post cast via Neynar API
    const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': NEYNAR_API_KEY
      },
      body: JSON.stringify(castBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Neynar cast error:', response.status, errorText);
      return res.status(response.status).json({
        success: false,
        error: `Neynar API error: ${errorText}`
      });
    }

    const data = await response.json();
    const castHash = data.cast?.hash;

    console.log(`✅ Cast posted successfully: ${castHash}`);

    return res.status(200).json({
      success: true,
      castHash: castHash,
      cast: data.cast
    });

  } catch (error) {
    console.error('Post cast error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
