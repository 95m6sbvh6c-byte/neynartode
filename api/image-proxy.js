/**
 * Image Proxy API
 *
 * Proxies images through our server to avoid CORS/403 issues with IPFS gateways
 * in Warpcast's webview context.
 *
 * Usage:
 *   GET /api/image-proxy?url=https://ipfs.io/ipfs/...
 *   GET /api/image-proxy?ipfs=bafybei...
 *   GET /api/image-proxy?contestId=123 (uses cached NFT image URL)
 */

// Multiple IPFS gateways to try (in order of preference)
const IPFS_GATEWAYS = [
  'https://nftstorage.link/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/'
];

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

  let imageUrl = req.query.url;
  const ipfsHash = req.query.ipfs;
  const contestId = req.query.contestId;

  try {
    // Mode 1: Direct IPFS hash
    if (ipfsHash) {
      imageUrl = `${IPFS_GATEWAYS[0]}${ipfsHash}`;
    }

    // Mode 2: Get URL from cached contest data
    if (contestId && !imageUrl) {
      if (process.env.KV_REST_API_URL) {
        const { kv } = require('@vercel/kv');
        const cached = await kv.get(`nft:contest:${contestId}`);
        if (cached && cached.image) {
          imageUrl = cached.image;
        }
      }
    }

    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing url, ipfs, or contestId parameter' });
    }

    // Convert IPFS URLs to gateway URLs
    if (imageUrl.startsWith('ipfs://')) {
      const hash = imageUrl.replace('ipfs://', '');
      imageUrl = `${IPFS_GATEWAYS[0]}${hash}`;
    }

    // For IPFS gateway URLs, try multiple gateways if one fails
    let response = null;
    let lastError = null;

    // Check if this is an IPFS URL we should try multiple gateways for
    const isIpfsUrl = IPFS_GATEWAYS.some(gw => imageUrl.includes(gw)) ||
                      imageUrl.includes('/ipfs/');

    if (isIpfsUrl) {
      // Extract the IPFS path (hash + any path after it)
      let ipfsPath = '';
      for (const gateway of IPFS_GATEWAYS) {
        if (imageUrl.includes(gateway)) {
          ipfsPath = imageUrl.split(gateway)[1];
          break;
        }
      }
      if (!ipfsPath && imageUrl.includes('/ipfs/')) {
        ipfsPath = imageUrl.split('/ipfs/')[1];
      }

      // Try each gateway
      for (const gateway of IPFS_GATEWAYS) {
        const tryUrl = `${gateway}${ipfsPath}`;
        try {
          console.log(`Trying gateway: ${tryUrl.substring(0, 60)}...`);
          response = await fetch(tryUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; ImageProxy/1.0)',
              'Accept': 'image/*'
            },
            signal: AbortSignal.timeout(10000) // 10 second timeout per gateway
          });

          if (response.ok) {
            console.log(`Success with gateway: ${gateway}`);
            break;
          } else {
            console.log(`Gateway ${gateway} returned ${response.status}`);
            lastError = new Error(`HTTP ${response.status}`);
            response = null;
          }
        } catch (err) {
          console.log(`Gateway ${gateway} failed: ${err.message}`);
          lastError = err;
          response = null;
        }
      }
    } else {
      // Non-IPFS URL, just fetch directly
      response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ImageProxy/1.0)',
          'Accept': 'image/*'
        },
        signal: AbortSignal.timeout(15000)
      });
    }

    if (!response || !response.ok) {
      console.error(`Failed to fetch image: ${lastError?.message || 'Unknown error'}`);
      return res.status(502).json({
        error: 'Failed to fetch image from source',
        details: lastError?.message
      });
    }

    // Get content type
    const contentType = response.headers.get('content-type') || 'image/png';

    // Set caching headers (cache for 1 day)
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Content-Type', contentType);

    // Stream the image to the response
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return res.status(200).send(buffer);

  } catch (error) {
    console.error('Image proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
};
