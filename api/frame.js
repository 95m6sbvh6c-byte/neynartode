/**
 * Frame Metadata API - HYBRID v1 + v2
 *
 * Returns Frame HTML with both Frame v1 (tx buttons) and Frame v2 (Mini App) formats.
 * Clients will use whichever format they support.
 *
 * GET /api/frame?contestId=30
 *
 * Returns: HTML with both fc:frame formats
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
  const appUrl = `https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes?contestId=${contestId}&action=enter`;

  // Frame v2 / Mini App embed JSON (for clients that support v2)
  const frameV2Embed = {
    version: "1",
    imageUrl: imageUrl,
    button: {
      title: "Enter Raffle",
      action: {
        type: "launch_frame",
        name: "NEYNARtodes",
        url: appUrl,
        splashImageUrl: `${BASE_URL}/neynartode-sticker.png`,
        splashBackgroundColor: "#1a1a2e"
      }
    }
  };

  // Frame HTML with BOTH v1 and v2 formats
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="NEYNARtodes Contest #${contestId}">
  <meta property="og:description" content="Enter to win! Tap Enter Raffle to join.">
  <meta property="og:image" content="${imageUrl}">

  <!-- Frame v2 / Mini App format (JSON) -->
  <meta name="fc:frame" content='${JSON.stringify(frameV2Embed)}' />

  <!-- Frame v1 format (individual meta tags) for backward compatibility -->
  <meta property="fc:frame" content="vNext">
  <meta property="fc:frame:image" content="${imageUrl}">
  <meta property="fc:frame:image:aspect_ratio" content="1.91:1">
  <meta property="fc:frame:post_url" content="${callbackUrl}">

  <!-- Button 1: Enter Raffle (transaction) -->
  <meta property="fc:frame:button:1" content="Enter Raffle">
  <meta property="fc:frame:button:1:action" content="tx">
  <meta property="fc:frame:button:1:target" content="${actionUrl}">
  <meta property="fc:frame:button:1:post_url" content="${callbackUrl}">

  <title>NEYNARtodes Contest #${contestId}</title>
</head>
<body>
  <h1>NEYNARtodes Contest #${contestId}</h1>
  <p>Enter to win! Tap Enter Raffle to join.</p>
  <a href="${appUrl}">Open App</a>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(html);
};
