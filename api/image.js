// Vercel Serverless Function - Generate Frame Image or Proxy NFT Images
// This creates the initial image shown in the Frame, or proxies IPFS images

export default async function handler(req, res) {
  // Set CORS headers for Farcaster
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // If a URL is provided, proxy that image (for NFT embeds)
  const { url } = req.query;
  if (url) {
    try {
      let fetchUrl = url;
      if (fetchUrl.startsWith('ipfs://')) {
        fetchUrl = fetchUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }

      const response = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NEYNARtodes/1.0)',
        },
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: `Failed to fetch: ${response.status}` });
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

      const buffer = await response.arrayBuffer();
      return res.status(200).send(Buffer.from(buffer));
    } catch (error) {
      console.error('Image proxy error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // Default: Generate the frame image
  res.setHeader('Content-Type', 'image/png');

  // Generate SVG image (you can replace this with a static PNG later)
  const svg = `
    <svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#7c3aed;stop-opacity:1" />
          <stop offset="50%" style="stop-color:#ec4899;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#7c3aed;stop-opacity:1" />
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="1200" height="1200" fill="url(#grad)"/>

      <!-- Content -->
      <text x="600" y="400" font-family="Arial, sans-serif" font-size="120" font-weight="bold" text-anchor="middle" fill="white">
        🐸 NEYNARtodes
      </text>

      <text x="600" y="550" font-family="Arial, sans-serif" font-size="60" font-weight="bold" text-anchor="middle" fill="white">
        Season 0 Beta
      </text>

      <rect x="300" y="650" width="600" height="200" rx="20" fill="rgba(255,255,255,0.2)"/>

      <text x="600" y="720" font-family="Arial, sans-serif" font-size="36" font-weight="bold" text-anchor="middle" fill="white">
        🔐 Beta Access Requirements:
      </text>

      <text x="600" y="770" font-family="Arial, sans-serif" font-size="28" text-anchor="middle" fill="white">
        • 74 Whitelisted Testers
      </text>

      <text x="600" y="810" font-family="Arial, sans-serif" font-size="28" text-anchor="middle" fill="white">
        • 20K NEYNARTODES Token Gate
      </text>

      <text x="600" y="1000" font-family="Arial, sans-serif" font-size="32" font-weight="bold" text-anchor="middle" fill="#fbbf24">
        Click "Launch App" to participate! 🚀
      </text>
    </svg>
  `;

  // Convert SVG to PNG (using sharp library - install: npm install sharp)
  try {
    const sharp = require('sharp');
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    res.status(200).send(pngBuffer);
  } catch (error) {
    // Fallback: return SVG if sharp is not available
    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
  }
}
