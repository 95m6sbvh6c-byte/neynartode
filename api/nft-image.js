/**
 * NFT Image Proxy API
 *
 * Proxies IPFS images through our server to avoid CORS/403 issues with Warpcast
 *
 * Usage: GET /api/nft-image?url=https://ipfs.io/ipfs/...
 */

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    // Convert IPFS URLs to use a reliable gateway
    let fetchUrl = url;
    if (fetchUrl.startsWith('ipfs://')) {
      fetchUrl = fetchUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    // Fetch the image
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NEYNARtodes/1.0)',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch image: ${response.status}` });
    }

    // Get content type
    const contentType = response.headers.get('content-type') || 'image/png';

    // Set response headers for caching
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); // Cache for 24 hours

    // Stream the image
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error('Image proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
};
