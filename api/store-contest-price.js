/**
 * Store Contest Price API
 *
 * Captures and stores the token price when a contest is created.
 * This ensures volume requirements are calculated fairly using the price
 * at contest start, not at finalization (prevents manipulation).
 *
 * Usage:
 *   POST /api/store-contest-price
 *   Body: { contestId: 22, tokenAddress: "0x..." }
 *
 *   GET /api/store-contest-price?contestId=22
 *   Returns: { contestId: 22, tokenPrice: 0.00000005, ethPrice: 3050.00, timestamp: ... }
 */

const { ethers } = require('ethers');
const { getTokenPriceUSD, getETHPrice, CONFIG } = require('./lib/uniswap-volume');

/**
 * Get token price with full metadata for storage
 * Returns: { tokenPrice, ethPrice, priceInETH, source }
 */
async function getTokenPriceWithMetadata(provider, tokenAddress) {
  const ethPrice = await getETHPrice(provider);
  const tokenPriceUSD = await getTokenPriceUSD(provider, tokenAddress);

  // Calculate priceInETH from USD values
  const priceInETH = tokenPriceUSD / ethPrice;

  // Determine source based on which pool type was used
  // The getTokenPriceUSD function logs the source, but doesn't return it
  // We'll check if we got a known V4 pool price by checking the token
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // GET: Retrieve stored price for a contest
    if (req.method === 'GET') {
      const contestId = req.query.contestId;

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

    // POST: Store price for a contest
    if (req.method === 'POST') {
      const { contestId, tokenAddress } = req.body;

      if (!contestId) {
        return res.status(400).json({ error: 'Missing contestId' });
      }

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

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
