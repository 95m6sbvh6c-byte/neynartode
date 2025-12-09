/**
 * Send Notification API
 *
 * Sends push notifications to users who have enabled notifications.
 * Can be called by other APIs or triggered by cron jobs.
 *
 * Notification Types:
 *   - new_contest: A new contest was created
 *   - contest_completed: A contest has ended and winner selected
 *   - contest_ending_soon: Contest ends in 1 hour
 *   - new_leaderboard_leader: New #1 on the leaderboard
 *   - prize_pool_funded: Host prize pool was funded
 *
 * Usage:
 *   POST /api/send-notification
 *   Body: { type: "new_contest", data: { ... } }
 *
 * Or call sendNotification() directly from other APIs
 */

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D';

/**
 * Get all notification subscribers
 */
async function getSubscribers() {
  if (!process.env.KV_REST_API_URL) {
    console.log('KV not configured');
    return [];
  }

  try {
    const { kv } = await import('@vercel/kv');

    // Get all subscriber FIDs
    const fids = await kv.smembers('notif:subscribers');

    // Get token data for each subscriber
    const subscribers = [];
    for (const fid of fids) {
      const data = await kv.hgetall(`notif:${fid}`);
      if (data && data.enabled && data.token && data.url) {
        subscribers.push({
          fid: parseInt(fid),
          token: data.token,
          url: data.url,
        });
      }
    }

    return subscribers;
  } catch (e) {
    console.error('Error getting subscribers:', e.message);
    return [];
  }
}

/**
 * Send notification to a single user via Warpcast
 */
async function sendToUser(token, url, title, body, targetUrl) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notificationId: `neynartodes-${Date.now()}`,
        title,
        body,
        targetUrl,
        tokens: [token],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Failed to send notification: ${response.status} - ${text}`);
      return false;
    }

    return true;
  } catch (e) {
    console.error('Error sending notification:', e.message);
    return false;
  }
}

/**
 * Truncate string to max length (for Farcaster notification limits)
 * Title: max 32 chars, Body: max 128 chars
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Build notification content based on type
 */
function buildNotificationContent(type, data) {
  const baseUrl = 'https://frame-opal-eight.vercel.app/';

  let title, body;

  switch (type) {
    case 'new_contest':
      title = 'New Contest Live!';
      body = data.prize
        ? `Win ${data.prize}! ${data.hostUsername ? `Hosted by @${data.hostUsername}` : ''}`
        : 'A new contest is now live!';
      break;

    case 'contest_completed':
      title = 'Winner Announced!';
      body = data.winnerUsername
        ? `@${data.winnerUsername} won ${data.prize || 'the contest'}!`
        : `Contest #${data.contestId} has ended!`;
      break;

    case 'contest_ending_soon':
      title = 'Contest Ending Soon!';
      body = data.prize
        ? `1 hour left to win ${data.prize}!`
        : `Contest #${data.contestId} ends in 1 hour!`;
      break;

    case 'new_leaderboard_leader':
      title = 'New #1 on Leaderboard!';
      body = data.username
        ? `@${data.username} is now #1!`
        : 'A new host has taken the #1 spot!';
      break;

    case 'prize_pool_funded':
      title = 'Prize Pool Funded!';
      body = data.amount
        ? `${data.amount} ETH added to Season ${data.season || ''} pool!`
        : 'The host prize pool has been funded!';
      break;

    default:
      title = 'NEYNARtodes Update';
      body = data.message || 'Something new is happening!';
  }

  return {
    title: truncate(title, 32),
    body: truncate(body, 128),
    targetUrl: baseUrl,
  };
}

/**
 * Send notification to all subscribers
 * @param {string} type - Notification type
 * @param {object} data - Data for the notification
 * @param {number[]} targetFids - Optional: Only send to specific FIDs
 */
async function sendNotification(type, data, targetFids = null) {
  const subscribers = await getSubscribers();

  if (subscribers.length === 0) {
    console.log('No subscribers to notify');
    return { sent: 0, failed: 0 };
  }

  const { title, body, targetUrl } = buildNotificationContent(type, data);

  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    // If targetFids specified, only send to those users
    if (targetFids && !targetFids.includes(sub.fid)) {
      continue;
    }

    const success = await sendToUser(sub.token, sub.url, title, body, targetUrl);
    if (success) {
      sent++;
    } else {
      failed++;
    }
  }

  console.log(`Notification "${type}" sent to ${sent} users, ${failed} failed`);
  return { sent, failed };
}

// Export for use by other APIs
module.exports.sendNotification = sendNotification;
module.exports.getSubscribers = getSubscribers;

// API handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth check - require a secret key
  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const expectedKey = process.env.NOTIFICATION_SECRET || 'neynartodes-notif-secret';

  if (authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { type, data, targetFids } = req.body;

    if (!type) {
      return res.status(400).json({ error: 'Missing notification type' });
    }

    const result = await sendNotification(type, data || {}, targetFids);

    return res.status(200).json({
      success: true,
      ...result,
    });

  } catch (error) {
    console.error('Send notification error:', error);
    return res.status(500).json({ error: error.message });
  }
};
