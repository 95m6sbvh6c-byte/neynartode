/**
 * Frame Metadata API - Frame v2 (Mini App)
 *
 * Returns Frame HTML that launches the NEYNARtodes mini app.
 * When user taps "Enter Raffle", the mini app opens with primary button.
 *
 * GET /api/frame?contestId=30
 *
 * Returns: HTML with Frame v2 format
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
  const appUrl = `https://farcaster.xyz/miniapps/uaKwcOvUry8F/neynartodes?contestId=${contestId}&action=enter`;

  // Frame v2 embed JSON - launches mini app
  const frameEmbed = {
    version: "next",
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

  // Clean Frame v2 HTML
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="NEYNARtodes Contest #${contestId}">
  <meta property="og:description" content="Enter to win! Tap Enter Raffle to join.">
  <meta property="og:image" content="${imageUrl}">

  <!-- Frame v2 / Mini App format -->
  <meta name="fc:frame" content='${JSON.stringify(frameEmbed)}' />

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
