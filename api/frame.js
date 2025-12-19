/**
 * Frame Metadata API - Frame v1 (Transaction Button)
 *
 * Returns Frame HTML with Frame v1 format for timeline transaction buttons.
 * When shared, displays an "Enter Raffle" button that triggers a transaction.
 *
 * GET /api/frame?contestId=30
 *
 * Returns: HTML with fc:frame v1 metadata
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
  const callbackUrl = `${BASE_URL}/api/frame-callback?contestId=${contestId}`;

  // Frame v1 HTML - clean format for transaction buttons
  // No v2 JSON to avoid parser conflicts
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="NEYNARtodes Contest #${contestId}">
  <meta property="og:description" content="Enter to win! Tap Enter Raffle to join.">
  <meta property="og:image" content="${imageUrl}">

  <!-- Frame v1 format -->
  <meta property="fc:frame" content="vNext">
  <meta property="fc:frame:image" content="${imageUrl}">
  <meta property="fc:frame:image:aspect_ratio" content="1.91:1">
  <meta property="fc:frame:post_url" content="${callbackUrl}">

  <!-- Button 1: Enter Raffle (transaction) -->
  <meta property="fc:frame:button:1" content="Enter Raffle 🎰">
  <meta property="fc:frame:button:1:action" content="tx">
  <meta property="fc:frame:button:1:target" content="${actionUrl}">
  <meta property="fc:frame:button:1:post_url" content="${callbackUrl}">

  <title>NEYNARtodes Contest #${contestId}</title>
</head>
<body>
  <h1>NEYNARtodes Contest #${contestId}</h1>
  <p>Enter to win! Tap Enter Raffle to join.</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-cache'); // Don't cache so image updates
  return res.status(200).send(html);
};
