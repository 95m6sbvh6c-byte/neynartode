/**
 * Store Custom Message API
 *
 * Stores custom winner messages for contests.
 * Uses Vercel KV or falls back to in-memory storage for testing.
 *
 * Usage:
 *   POST /api/store-message
 *   Body: { contestId: 7, message: "You just won our amazing giveaway!" }
 *
 *   GET /api/store-message?contestId=7
 *   Returns: { contestId: 7, message: "..." }
 */

// In-memory storage (for development/testing)
// In production, use Vercel KV, Redis, or a database
const messageStore = new Map();

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // GET: Retrieve message for a contest
    if (req.method === 'GET') {
      const contestId = req.query.contestId;

      if (!contestId) {
        return res.status(400).json({ error: 'Missing contestId' });
      }

      // Try Vercel KV first (if available)
      if (process.env.KV_REST_API_URL) {
        try {
          const { kv } = require('@vercel/kv');
          const message = await kv.get(`contest_message_${contestId}`);
          return res.status(200).json({ contestId, message: message || null });
        } catch (e) {
          console.log('KV not available, using memory store');
        }
      }

      // Fall back to in-memory
      const message = messageStore.get(contestId);
      return res.status(200).json({ contestId, message: message || null });
    }

    // POST: Store message for a contest
    if (req.method === 'POST') {
      const { contestId, message } = req.body;

      if (!contestId) {
        return res.status(400).json({ error: 'Missing contestId' });
      }

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid message' });
      }

      // Limit message length
      const trimmedMessage = message.slice(0, 500);

      // Try Vercel KV first (if available)
      if (process.env.KV_REST_API_URL) {
        try {
          const { kv } = require('@vercel/kv');
          await kv.set(`contest_message_${contestId}`, trimmedMessage);
          return res.status(200).json({
            success: true,
            contestId,
            message: trimmedMessage,
            storage: 'kv'
          });
        } catch (e) {
          console.log('KV not available, using memory store');
        }
      }

      // Fall back to in-memory
      messageStore.set(contestId.toString(), trimmedMessage);
      return res.status(200).json({
        success: true,
        contestId,
        message: trimmedMessage,
        storage: 'memory'
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
