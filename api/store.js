/**
 * Consolidated Store API
 *
 * Handles storage for contest messages, prices, and NFT values.
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
 *   Price Storage (Token Contests):
 *     POST /api/store?type=price
 *     Body: { contestId: 22, tokenAddress: "0x...", prizeAmount: 1000000 }
 *
 *     GET /api/store?type=price&contestId=22
 *     Returns: { contestId: 22, tokenPrice: 0.00000005, ethPrice: 3050.00, prizeValueUSD: 50.00, timestamp: ... }
 *
 *   NFT Price Storage (NFT Contests):
 *     POST /api/store?type=nftprice
 *     Body: { contestId: "NFT-5", floorPriceETH: 0.05 }
 *
 *     GET /api/store?type=nftprice&contestId=NFT-5
 *     Returns: { contestId: "NFT-5", floorPriceETH: 0.05, ethPrice: 3050.00, floorPriceUSD: 152.50, timestamp: ... }
 */

const { ethers } = require('ethers');
const { getTokenPriceWithLiquidity, getETHPrice, CONFIG } = require('./lib/uniswap-volume');

// Minimum pool liquidity (USD) required for a token to be accepted as a prize
const MIN_LIQUIDITY_USD = 1000;

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
  const result = await getTokenPriceWithLiquidity(provider, tokenAddress);
  const priceInETH = result.priceUSD / ethPrice;

  return {
    tokenPrice: result.priceUSD,
    ethPrice,
    priceInETH,
    source: result.source,
    liquidityUSD: result.liquidityUSD
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

async function storePrice(contestId, tokenAddress, prizeAmount, res) {
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const timestamp = Math.floor(Date.now() / 1000);

  let priceData;

  if (tokenAddress === 'ETH_NATIVE') {
    // Native ETH prize: prizeAmount is in ETH, get ETH price directly
    const ethPrice = await getETHPrice(provider);
    const prizeValueUSD = prizeAmount ? prizeAmount * ethPrice : null;

    priceData = {
      tokenAddress: 'ETH_NATIVE',
      tokenPrice: ethPrice,
      ethPrice,
      priceInETH: 1,
      prizeAmount: prizeAmount || null,
      prizeValueUSD: prizeValueUSD ? Math.round(prizeValueUSD * 100) / 100 : null,
      source: 'chainlink',
      timestamp,
      capturedAt: new Date().toISOString()
    };
  } else {
    // Default to NEYNARTODES if no token specified
    const token = tokenAddress || CONFIG.NEYNARTODES_TOKEN;

    // Get current price with metadata (includes liquidity)
    const priceInfo = await getTokenPriceWithMetadata(provider, token);

    // Liquidity check: reject illiquid tokens
    // liquidityUSD is null for known/vetted pools (which is fine)
    // liquidityUSD is 0 for fallback (no pool found)
    // liquidityUSD is a number for discovered V2/V3 pools
    if (priceInfo.liquidityUSD !== null && priceInfo.liquidityUSD < MIN_LIQUIDITY_USD) {
      console.log(`REJECTED: Contest ${contestId} token ${token} has insufficient liquidity: $${priceInfo.liquidityUSD?.toFixed(2) || 0} (min: $${MIN_LIQUIDITY_USD})`);
      return res.status(400).json({
        error: 'Token has insufficient liquidity',
        liquidityUSD: priceInfo.liquidityUSD ? Math.round(priceInfo.liquidityUSD * 100) / 100 : 0,
        minLiquidityUSD: MIN_LIQUIDITY_USD,
        message: `This token only has $${priceInfo.liquidityUSD?.toFixed(2) || 0} in pool liquidity. Minimum required: $${MIN_LIQUIDITY_USD}.`
      });
    }

    // Calculate prize value in USD if prizeAmount provided
    const prizeValueUSD = prizeAmount ? prizeAmount * priceInfo.tokenPrice : null;

    priceData = {
      tokenAddress: token,
      tokenPrice: priceInfo.tokenPrice,
      ethPrice: priceInfo.ethPrice,
      priceInETH: priceInfo.priceInETH,
      prizeAmount: prizeAmount || null,
      prizeValueUSD: prizeValueUSD ? Math.round(prizeValueUSD * 100) / 100 : null,
      source: priceInfo.source,
      timestamp,
      capturedAt: new Date().toISOString()
    };
  }

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
// NFT PRICE HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function getNftPrice(contestId, res) {
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  if (process.env.KV_REST_API_URL) {
    const { kv } = require('@vercel/kv');
    const priceData = await kv.get(`nft_price_${contestId}`);

    if (priceData) {
      return res.status(200).json({
        contestId,
        ...priceData
      });
    }
  }

  return res.status(404).json({
    error: 'No NFT price stored for this contest',
    contestId
  });
}

async function storeNftPrice(contestId, floorPriceETH, nftMetadata, res) {
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Get current ETH price
  const ethPrice = await getETHPrice(provider);
  const timestamp = Math.floor(Date.now() / 1000);

  // Calculate floor price in USD
  const floorPriceUSD = floorPriceETH ? floorPriceETH * ethPrice : null;

  const priceData = {
    floorPriceETH: floorPriceETH || null,
    ethPrice: ethPrice,
    floorPriceUSD: floorPriceUSD ? Math.round(floorPriceUSD * 100) / 100 : null,
    // NFT metadata (stored for cached access)
    nftName: nftMetadata?.nftName || null,
    nftImage: nftMetadata?.nftImage || null,
    nftContract: nftMetadata?.nftContract || null,
    nftTokenId: nftMetadata?.nftTokenId || null,
    nftCollection: nftMetadata?.nftCollection || null,
    timestamp,
    capturedAt: new Date().toISOString()
  };

  // Store in KV
  if (process.env.KV_REST_API_URL) {
    const { kv } = require('@vercel/kv');
    await kv.set(`nft_price_${contestId}`, priceData);

    console.log(`Stored NFT price for contest ${contestId}:`, priceData);

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

  if (!type || !['message', 'price', 'nftprice', 'admin-set-prize'].includes(type)) {
    return res.status(400).json({
      error: 'Missing or invalid type parameter',
      usage: 'Use ?type=message, ?type=price, or ?type=nftprice'
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
        const { contestId, tokenAddress, prizeAmount } = req.body;
        return storePrice(contestId, tokenAddress, prizeAmount, res);
      }
    }

    if (type === 'admin-set-prize') {
      const authKey = req.headers.authorization?.replace('Bearer ', '');
      const expectedKey = process.env.NOTIFICATION_SECRET || 'neynartodes-notif-secret';
      if (authKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (req.method === 'GET') {
        const { contestId } = req.query;
        if (!contestId) return res.status(400).json({ error: 'Missing contestId' });
        if (process.env.KV_REST_API_URL) {
          const { kv } = require('@vercel/kv');
          const data = await kv.get(`contest_price_prize_${contestId}`);
          return res.status(200).json({ contestId, data });
        }
        return res.status(500).json({ error: 'KV not configured' });
      }
      if (req.method === 'POST') {
        const { contestId, prizeValueUSD } = req.body;
        if (!contestId || prizeValueUSD == null) {
          return res.status(400).json({ error: 'Missing contestId or prizeValueUSD' });
        }
        if (process.env.KV_REST_API_URL) {
          const { kv } = require('@vercel/kv');
          await kv.set(`contest_price_prize_${contestId}`, { prizeValueUSD, adminOverride: true });
          return res.status(200).json({ success: true, contestId, prizeValueUSD, adminOverride: true });
        }
        return res.status(500).json({ error: 'KV not configured' });
      }
    }

    if (type === 'nftprice') {
      if (req.method === 'GET') {
        return getNftPrice(req.query.contestId, res);
      } else if (req.method === 'POST') {
        const { contestId, floorPriceETH, nftName, nftImage, nftContract, nftTokenId, nftCollection } = req.body;
        const nftMetadata = { nftName, nftImage, nftContract, nftTokenId, nftCollection };
        return storeNftPrice(contestId, floorPriceETH, nftMetadata, res);
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
