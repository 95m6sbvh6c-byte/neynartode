// Vercel Serverless Function - Show Leaderboard in Frame

const NEYNAR_API_KEY = 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D';

const WHITELIST_FIDS = [
  1020, 10956, 202051, 217530, 280534, 368206, 466345, 473136,
  655816, 918820, 1009822, 1188162, 1328864, 8425, 16538, 191870
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Fetch top 5 users from Neynar
    const topFids = WHITELIST_FIDS.slice(0, 5);
    const fidsParam = topFids.join(',');

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fidsParam}`,
      {
        headers: {
          'api_key': NEYNAR_API_KEY,
        },
      }
    );

    const data = await response.json();
    const users = data.users || [];

    // Sort by followers
    users.sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0));

    const image = generateLeaderboardImage(users);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="fc:frame" content="vNext" />
          <meta property="fc:frame:image" content="data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}" />
          <meta property="fc:frame:button:1" content="🎮 Open Full App" />
          <meta property="fc:frame:button:1:action" content="link" />
          <meta property="fc:frame:button:1:target" content="https://neynartode.vercel.app/app" />
          <meta property="fc:frame:button:2" content="🔄 Refresh" />
          <meta property="fc:frame:button:2:action" content="post" />
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

function generateLeaderboardImage(users) {
  const rows = users.slice(0, 5).map((user, idx) => {
    const rank = idx + 1;
    const emoji = rank === 1 ? '👑' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    const followers = (user.follower_count || 0).toLocaleString();

    return `
      <text x="100" y="${200 + idx * 120}" font-family="Arial, sans-serif" font-size="50" font-weight="bold" fill="white">
        ${emoji}
      </text>
      <text x="200" y="${200 + idx * 120}" font-family="Arial, sans-serif" font-size="50" font-weight="bold" fill="white">
        @${user.username}
      </text>
      <text x="900" y="${200 + idx * 120}" font-family="Arial, sans-serif" font-size="40" fill="#fbbf24" text-anchor="end">
        ${followers} followers
      </text>
    `;
  }).join('');

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

      <text x="600" y="100" font-family="Arial, sans-serif" font-size="80" font-weight="bold" text-anchor="middle" fill="white">
        🦎 TOP 5 BETA TESTERS 🦎
      </text>

      <rect x="50" y="150" width="1100" height="700" rx="20" fill="rgba(255,255,255,0.1)"/>

      ${rows}

      <text x="600" y="1050" font-family="Arial, sans-serif" font-size="40" font-weight="bold" text-anchor="middle" fill="#fbbf24">
        🐸 NEYNARtodes Season 0 Beta
      </text>

      <text x="600" y="1120" font-family="Arial, sans-serif" font-size="30" text-anchor="middle" fill="white">
        Click "Open Full App" to vote!
      </text>
    </svg>
  `;
}
