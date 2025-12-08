/**
 * Consolidated Store API
 *
 * Handles storage for contest messages and prices.
 * Uses Vercel KV or falls back to in-memory storage for testing.
 *
 * Routes (via query param 'type'):
 *
 *   Message Storage:
 *     POST /api/store?type=message
 *     Body: { contestId: 7, message: "You just won our amazing giveaway!" }
 *
 *     GET /api/store?type=message&contestId=7
 *     Returns: { contestId: 7, message: "..." }
 *
 *   Price Storage:
 *     POST /api/store?type=price
 *     Body: { contestId: 22, tokenAddress: "0x..." }
 *
 *     GET /api/store?type=price&contestId=22
 *     Returns: { contestId: 22, tokenPrice: 0.00000005, ethPrice: 3050.00, timestamp: ... }
 */

const { ethers } = require('ethers');
const { getTokenPriceUSD, getETHPrice, CONFIG } = require('./lib/uniswap-volume');

// In-memory storage (for development/testing)
const messageStore = new Map();

// ═══════════════════════════════════════════════════════════════════
// MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function getMessage(contestId, res) {
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

async function storeMessage(contestId, message, res) {
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

// ═══════════════════════════════════════════════════════════════════
// PRICE HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function getTokenPriceWithMetadata(provider, tokenAddress) {
  const ethPrice = await getETHPrice(provider);
  const tokenPriceUSD = await getTokenPriceUSD(provider, tokenAddress);

  // Calculate priceInETH from USD values
  const priceInETH = tokenPriceUSD / ethPrice;

  // Determine source based on which pool type was used
  let source = 'unknown';
  const knownV4Tokens = ['0x8de1622fe07f56cda2e2273e615a513f1d828b07'];
  if (knownV4Tokens.includes(tokenAddress.toLowerCase())) {
    source = 'V4-known-pool';
  } else if (tokenPriceUSD === 0.0001) {
    source = 'fallback';
  } else {
    source = 'DEX';
  }

  return {
    tokenPrice: tokenPriceUSD,
    ethPrice,
    priceInETH,
    source
  };
}

async function getPrice(contestId, res) {
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  if (process.env.KV_REST_API_URL) {
    const { kv } = require('@vercel/kv');
    const priceData = await kv.get(`contest_price_${contestId}`);

    if (priceData) {
      return res.status(200).json({
        contestId,
        ...priceData
      });
    }
  }

  return res.status(404).json({
    error: 'No price stored for this contest',
    contestId
  });
}

async function storePrice(contestId, tokenAddress, res) {
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Default to NEYNARTODES if no token specified
  const token = tokenAddress || CONFIG.NEYNARTODES_TOKEN;

  // Get current price with metadata
  const priceInfo = await getTokenPriceWithMetadata(provider, token);
  const timestamp = Math.floor(Date.now() / 1000);

  const priceData = {
    tokenAddress: token,
    tokenPrice: priceInfo.tokenPrice,
    ethPrice: priceInfo.ethPrice,
    priceInETH: priceInfo.priceInETH,
    source: priceInfo.source,
    timestamp,
    capturedAt: new Date().toISOString()
  };

  // Store in KV
  if (process.env.KV_REST_API_URL) {
    const { kv } = require('@vercel/kv');
    await kv.set(`contest_price_${contestId}`, priceData);

    console.log(`Stored price for contest ${contestId}:`, priceData);

    return res.status(200).json({
      success: true,
      contestId,
      ...priceData
    });
  }

  return res.status(500).json({
    error: 'KV storage not configured'
  });
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { type } = req.query;

  if (!type || !['message', 'price'].includes(type)) {
    return res.status(400).json({
      error: 'Missing or invalid type parameter',
      usage: 'Use ?type=message or ?type=price'
    });
  }

  try {
    if (type === 'message') {
      if (req.method === 'GET') {
        return getMessage(req.query.contestId, res);
      } else if (req.method === 'POST') {
        const { contestId, message } = req.body;
        return storeMessage(contestId, message, res);
      }
    }

    if (type === 'price') {
      if (req.method === 'GET') {
        return getPrice(req.query.contestId, res);
      } else if (req.method === 'POST') {
        const { contestId, tokenAddress } = req.body;
        return storePrice(contestId, tokenAddress, res);
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
