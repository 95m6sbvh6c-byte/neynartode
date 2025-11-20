// Vercel Serverless Function - Connect Wallet
// This handles the "Connect Wallet" button click

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { untrustedData } = req.body;
    const fid = untrustedData?.fid;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="fc:frame" content="vNext" />
          <meta property="fc:frame:image" content="data:image/svg+xml;base64,${Buffer.from(generateConnectImage(fid)).toString('base64')}" />
          <meta property="fc:frame:button:1" content="📊 Check My Access" />
          <meta property="fc:frame:button:1:action" content="post" />
          <meta property="fc:frame:button:1:target" content="https://YOUR_DOMAIN/api/check-access" />
          <meta property="fc:frame:button:2" content="🎮 Launch App" />
          <meta property="fc:frame:button:2:action" content="link" />
          <meta property="fc:frame:button:2:target" content="https://YOUR_DOMAIN/app" />
        </head>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to process' });
  }
}

function generateConnectImage(fid) {
  return `
    <svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#7c3aed;stop-opacity:1" />
          <stop offset="50%" style="stop-color:#ec4899;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#7c3aed;stop-opacity:1" />
        </linearGradient>
      </defs>

      <rect width="1200" height="1200" fill="url(#grad)"/>

      <text x="600" y="300" font-family="Arial, sans-serif" font-size="100" text-anchor="middle" fill="white">
        🔗
      </text>

      <text x="600" y="450" font-family="Arial, sans-serif" font-size="60" font-weight="bold" text-anchor="middle" fill="white">
        Connected!
      </text>

      <rect x="200" y="550" width="800" height="300" rx="20" fill="rgba(255,255,255,0.2)"/>

      <text x="600" y="640" font-family="Arial, sans-serif" font-size="40" text-anchor="middle" fill="white">
        Your Farcaster ID: ${fid || 'Unknown'}
      </text>

      <text x="600" y="720" font-family="Arial, sans-serif" font-size="36" text-anchor="middle" fill="white">
        Click "Check My Access" to verify
      </text>

      <text x="600" y="780" font-family="Arial, sans-serif" font-size="36" text-anchor="middle" fill="white">
        your Season 0 eligibility!
      </text>

      <text x="600" y="1000" font-family="Arial, sans-serif" font-size="32" font-weight="bold" text-anchor="middle" fill="#fbbf24">
        🐸 NEYNARtodes Season 0 Beta
      </text>
    </svg>
  `;
}
