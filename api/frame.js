/**
 * Frame Metadata API
 *
 * Returns Frame HTML with Open Graph tags for Farcaster timeline embeds.
 * When a contest is shared, this URL is embedded and shows interactive buttons.
 *
 * GET /api/frame?contestId=30
 *
 * Returns: HTML with fc:frame meta tags
 */

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://frame-opal-eight.vercel.app';

module.exports = async (req, res) => {
  const { contestId } = req.query;

  if (!contestId) {
    return res.status(400).send('Missing contestId');
  }

  // Construct URLs for frame elements
  const imageUrl = `${BASE_URL}/api/frame-image?contestId=${contestId}&t=${Date.now()}`;
  const actionUrl = `${BASE_URL}/api/frame-action?contestId=${contestId}`;
  const miniAppUrl = `https://farcaster.xyz/miniapps/neynartodes?contestId=${contestId}`;

  // Frame HTML with Open Graph and Farcaster Frame meta tags
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="NEYNARtodes Contest #${contestId}">
  <meta property="og:description" content="Enter to win! Like, recast, and reply for bonus entries.">
  <meta property="og:image" content="${imageUrl}">

  <!-- Farcaster Frame v2 -->
  <meta property="fc:frame" content="vNext">
  <meta property="fc:frame:image" content="${imageUrl}">
  <meta property="fc:frame:image:aspect_ratio" content="1.91:1">

  <!-- Button 1: Enter Raffle (transaction) -->
  <meta property="fc:frame:button:1" content="Enter Raffle">
  <meta property="fc:frame:button:1:action" content="tx">
  <meta property="fc:frame:button:1:target" content="${actionUrl}">
  <meta property="fc:frame:button:1:post_url" content="${BASE_URL}/api/frame-callback?contestId=${contestId}">

  <!-- Button 2: View Contest (link to mini app) -->
  <meta property="fc:frame:button:2" content="View Contest">
  <meta property="fc:frame:button:2:action" content="link">
  <meta property="fc:frame:button:2:target" content="${miniAppUrl}">

  <title>NEYNARtodes Contest #${contestId}</title>
</head>
<body>
  <h1>NEYNARtodes Contest #${contestId}</h1>
  <p>Enter to win! Like, recast, and reply for bonus entries.</p>
  <a href="${miniAppUrl}">Open in Mini App</a>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(html);
};
