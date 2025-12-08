/**
 * Fetch NFT Metadata API (Server-side proxy)
 *
 * Fetches NFT metadata from tokenURI endpoints that may have CORS restrictions.
 * This allows the frontend to fetch metadata from any source.
 *
 * Usage:
 *   GET /api/fetch-nft-metadata?url=https://...
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

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    // Validate URL format
    let metadataUrl = url;

    // Convert IPFS URLs to gateway
    if (metadataUrl.startsWith('ipfs://')) {
      metadataUrl = metadataUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    // Fetch the metadata
    const response = await fetch(metadataUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'NEYNARtodes-Frame/1.0'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: `Failed to fetch metadata: ${response.status} ${response.statusText}`
      });
    }

    const contentType = response.headers.get('content-type');

    // Check if response is JSON
    if (contentType && contentType.includes('application/json')) {
      const metadata = await response.json();

      // Process image URLs
      if (metadata.image && metadata.image.startsWith('ipfs://')) {
        metadata.image = metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }
      if (metadata.image_url && metadata.image_url.startsWith('ipfs://')) {
        metadata.image_url = metadata.image_url.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }

      return res.status(200).json({
        success: true,
        metadata
      });
    } else {
      // Try to parse as JSON anyway (some servers don't set content-type correctly)
      const text = await response.text();
      try {
        const metadata = JSON.parse(text);

        if (metadata.image && metadata.image.startsWith('ipfs://')) {
          metadata.image = metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }

        return res.status(200).json({
          success: true,
          metadata
        });
      } catch (parseError) {
        return res.status(400).json({
          success: false,
          error: 'Response is not valid JSON'
        });
      }
    }

  } catch (error) {
    console.error('Fetch NFT metadata error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
