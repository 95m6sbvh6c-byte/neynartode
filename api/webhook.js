/**
 * Webhook Handler for Farcaster Notifications
 *
 * Handles notification subscription events from Warpcast.
 * Stores user notification tokens in Vercel KV for sending notifications.
 *
 * Events:
 *   - frame_added: User added the frame and enabled notifications
 *   - frame_removed: User removed the frame
 *   - notifications_enabled: User enabled notifications
 *   - notifications_disabled: User disabled notifications
 */

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D';

/**
 * Store notification token in KV
 */
async function storeNotificationToken(fid, token, url) {
  if (!process.env.KV_REST_API_URL) {
    console.log('KV not configured, skipping token storage');
    return false;
  }

  try {
    const { kv } = await import('@vercel/kv');

    // Store token data
    await kv.hset(`notif:${fid}`, {
      token,
      url,
      enabled: true,
      updatedAt: Date.now(),
    });

    // Add to set of all subscribers
    await kv.sadd('notif:subscribers', fid.toString());

    console.log(`Stored notification token for FID ${fid}`);
    return true;
  } catch (e) {
    console.error('Error storing notification token:', e.message);
    return false;
  }
}

/**
 * Remove notification token from KV
 */
async function removeNotificationToken(fid) {
  if (!process.env.KV_REST_API_URL) {
    return false;
  }

  try {
    const { kv } = await import('@vercel/kv');

    await kv.del(`notif:${fid}`);
    await kv.srem('notif:subscribers', fid.toString());

    console.log(`Removed notification token for FID ${fid}`);
    return true;
  } catch (e) {
    console.error('Error removing notification token:', e.message);
    return false;
  }
}

/**
 * Disable notifications for user (keep token but mark disabled)
 */
async function disableNotifications(fid) {
  if (!process.env.KV_REST_API_URL) {
    return false;
  }

  try {
    const { kv } = await import('@vercel/kv');

    await kv.hset(`notif:${fid}`, {
      enabled: false,
      updatedAt: Date.now(),
    });

    console.log(`Disabled notifications for FID ${fid}`);
    return true;
  } catch (e) {
    console.error('Error disabling notifications:', e.message);
    return false;
  }
}

/**
 * Verify the webhook signature (optional but recommended)
 */
function verifySignature(req) {
  // TODO: Implement signature verification if Warpcast provides it
  return true;
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    // Verify signature
    if (!verifySignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { event } = body;

    if (!event) {
      return res.status(400).json({ error: 'Missing event type' });
    }

    switch (event) {
      case 'frame_added': {
        // User added the frame - they may have notification token
        const { fid, notificationDetails } = body;

        if (notificationDetails?.token && notificationDetails?.url) {
          await storeNotificationToken(fid, notificationDetails.token, notificationDetails.url);
          console.log(`Frame added with notifications for FID ${fid}`);
        } else {
          console.log(`Frame added without notifications for FID ${fid}`);
        }
        break;
      }

      case 'frame_removed': {
        // User removed the frame - clean up their token
        const { fid } = body;
        await removeNotificationToken(fid);
        console.log(`Frame removed for FID ${fid}`);
        break;
      }

      case 'notifications_enabled': {
        // User enabled notifications
        const { fid, notificationDetails } = body;

        if (notificationDetails?.token && notificationDetails?.url) {
          await storeNotificationToken(fid, notificationDetails.token, notificationDetails.url);
          console.log(`Notifications enabled for FID ${fid}`);
        }
        break;
      }

      case 'notifications_disabled': {
        // User disabled notifications
        const { fid } = body;
        await disableNotifications(fid);
        console.log(`Notifications disabled for FID ${fid}`);
        break;
      }

      default:
        console.log(`Unknown event type: ${event}`);
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
};
