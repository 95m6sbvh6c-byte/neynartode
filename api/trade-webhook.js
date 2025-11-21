/**
 * Neynar Trade Webhook Handler
 *
 * Receives real-time trade notifications from Neynar and stores them
 * for contest volume verification.
 *
 * Webhook Event: trade.created
 * Filters available:
 *   - fids: Filter by specific Farcaster user IDs
 *   - minimum_trader_neynar_score: Filter by user score (0-1)
 *   - minimum_token_amount_usdc: Filter by minimum trade value
 *
 * Setup:
 * 1. Go to Neynar Dashboard -> Webhooks -> Create
 * 2. Set URL to: https://your-app.vercel.app/api/trade-webhook
 * 3. Select event: trade.created
 * 4. Save the webhook secret for verification
 */

const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// STORAGE - Uses Vercel KV if available, falls back to in-memory
// ═══════════════════════════════════════════════════════════════════

// In-memory fallback
const tradeStoreMemory = new Map();

// Check if Vercel KV is available
const hasKV = !!process.env.KV_REST_API_URL;

/**
 * Get trade data from storage
 */
async function getTradeData(tokenAddress, walletAddress) {
  const key = `trade_${tokenAddress.toLowerCase()}_${walletAddress.toLowerCase()}`;

  if (hasKV) {
    try {
      const { kv } = require('@vercel/kv');
      const data = await kv.get(key);
      return data || { volume: 0, trades: [] };
    } catch (e) {
      console.log('KV get failed, using memory:', e.message);
    }
  }

  // Memory fallback
  const tokenTrades = tradeStoreMemory.get(tokenAddress.toLowerCase());
  if (!tokenTrades) return { volume: 0, trades: [] };
  return tokenTrades.get(walletAddress.toLowerCase()) || { volume: 0, trades: [] };
}

/**
 * Save trade data to storage
 */
async function saveTradeData(tokenAddress, walletAddress, data) {
  const key = `trade_${tokenAddress.toLowerCase()}_${walletAddress.toLowerCase()}`;

  if (hasKV) {
    try {
      const { kv } = require('@vercel/kv');
      // Store with 30 day expiry (trades older than that aren't relevant)
      await kv.set(key, data, { ex: 60 * 60 * 24 * 30 });

      // Also track which tokens/wallets we have data for
      await kv.sadd(`trade_tokens`, tokenAddress.toLowerCase());
      await kv.sadd(`trade_wallets_${tokenAddress.toLowerCase()}`, walletAddress.toLowerCase());
      return;
    } catch (e) {
      console.log('KV save failed, using memory:', e.message);
    }
  }

  // Memory fallback
  if (!tradeStoreMemory.has(tokenAddress.toLowerCase())) {
    tradeStoreMemory.set(tokenAddress.toLowerCase(), new Map());
  }
  tradeStoreMemory.get(tokenAddress.toLowerCase()).set(walletAddress.toLowerCase(), data);
}

/**
 * Get all traders for a token
 */
async function getAllTraders(tokenAddress) {
  if (hasKV) {
    try {
      const { kv } = require('@vercel/kv');
      const wallets = await kv.smembers(`trade_wallets_${tokenAddress.toLowerCase()}`);

      const traders = [];
      for (const wallet of wallets || []) {
        const data = await getTradeData(tokenAddress, wallet);
        if (data.volume > 0) {
          traders.push({
            address: wallet,
            volume: data.volume,
            tradeCount: data.trades?.length || 0
          });
        }
      }
      return traders.sort((a, b) => b.volume - a.volume);
    } catch (e) {
      console.log('KV getAllTraders failed:', e.message);
    }
  }

  // Memory fallback
  const tokenTrades = tradeStoreMemory.get(tokenAddress.toLowerCase());
  if (!tokenTrades) return [];

  const traders = [];
  for (const [wallet, data] of tokenTrades) {
    if (data.volume > 0) {
      traders.push({
        address: wallet,
        volume: data.volume,
        tradeCount: data.trades?.length || 0
      });
    }
  }
  return traders.sort((a, b) => b.volume - a.volume);
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Verify webhook signature from Neynar
 * @param {string} body - Raw request body
 * @param {string} signature - X-Neynar-Signature header
 * @param {string} secret - Webhook secret from Neynar dashboard
 */
function verifySignature(body, signature, secret) {
  if (!secret) {
    console.log('⚠️ NEYNAR_WEBHOOK_SECRET not set - skipping verification');
    return true; // Allow in dev mode
  }

  const hmac = crypto.createHmac('sha512', secret);
  hmac.update(body);
  const expectedSignature = hmac.digest('hex');

  return signature === expectedSignature;
}

// ═══════════════════════════════════════════════════════════════════
// TRADE PROCESSING
// ═══════════════════════════════════════════════════════════════════

/**
 * Store a trade event
 */
async function storeTrade(trade) {
  const tokenAddress = trade.token_address?.toLowerCase();
  const walletAddress = trade.trader_wallet?.toLowerCase();

  if (!tokenAddress || !walletAddress) {
    console.log('⚠️ Invalid trade data - missing token or wallet');
    return;
  }

  // Get existing data
  const walletData = await getTradeData(tokenAddress, walletAddress);

  // Calculate trade volume (absolute value of amount)
  const tradeVolume = Math.abs(parseFloat(trade.token_amount || 0));

  // Update totals
  walletData.volume = (walletData.volume || 0) + tradeVolume;
  walletData.trades = walletData.trades || [];
  walletData.trades.push({
    timestamp: trade.timestamp || Date.now(),
    amount: tradeVolume,
    usdValue: trade.usd_value || 0,
    txHash: trade.tx_hash,
    fid: trade.fid
  });

  // Keep only last 100 trades per wallet (memory management)
  if (walletData.trades.length > 100) {
    walletData.trades = walletData.trades.slice(-100);
  }

  // Save updated data
  await saveTradeData(tokenAddress, walletAddress, walletData);

  console.log(`📊 Trade stored: ${walletAddress.slice(0,8)}... traded ${tradeVolume.toLocaleString()} of ${tokenAddress.slice(0,8)}... (${hasKV ? 'KV' : 'memory'})`);
}

/**
 * Get trading volume for a wallet on a specific token
 * @param {string} tokenAddress - Token contract address
 * @param {string} walletAddress - Wallet address
 * @param {number} startTime - Optional: Only count trades after this timestamp
 * @param {number} endTime - Optional: Only count trades before this timestamp
 */
async function getVolume(tokenAddress, walletAddress, startTime = 0, endTime = Infinity) {
  const walletData = await getTradeData(tokenAddress, walletAddress);
  if (!walletData || !walletData.trades) return 0;

  // Filter by time range if specified
  if (startTime > 0 || endTime < Infinity) {
    return walletData.trades
      .filter(t => t.timestamp >= startTime && t.timestamp <= endTime)
      .reduce((sum, t) => sum + t.amount, 0);
  }

  return walletData.volume || 0;
}

/**
 * Get all wallets that traded a token with their volumes
 */
async function getTradersByToken(tokenAddress, minVolume = 0) {
  const traders = await getAllTraders(tokenAddress);
  return traders.filter(t => t.volume >= minVolume);
}

/**
 * Check multiple addresses against volume requirement
 * Returns which addresses pass
 */
async function checkVolumes(tokenAddress, addresses, minVolume, startTime = 0, endTime = Infinity) {
  const results = [];
  for (const addr of addresses) {
    const volume = await getVolume(tokenAddress, addr, startTime, endTime);
    results.push({
      address: addr,
      volume,
      passed: volume >= minVolume
    });
  }
  return results;
}

// Export for use in finalize-contest.js
module.exports.getVolume = getVolume;
module.exports.getTradersByToken = getTradersByToken;
module.exports.checkVolumes = checkVolumes;

// ═══════════════════════════════════════════════════════════════════
// VERCEL API HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Neynar-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Query stored trade data or simulate test trade
  if (req.method === 'GET') {
    const { token, wallet, minVolume, test, amount } = req.query;

    // Test mode: simulate a trade (for development/demo)
    if (test === 'true' && token && wallet) {
      const tradeAmount = parseFloat(amount) || 10000;
      await storeTrade({
        fid: 1188162,
        trader_wallet: wallet,
        token_address: token,
        token_amount: tradeAmount.toString(),
        usd_value: tradeAmount * 0.0001,
        tx_hash: `0xtest_${Date.now()}`,
        timestamp: Date.now()
      });
      return res.status(200).json({
        success: true,
        message: `Test trade stored: ${wallet.slice(0,10)}... traded ${tradeAmount} tokens`,
        storage: hasKV ? 'kv' : 'memory'
      });
    }

    if (token && wallet) {
      // Get volume for specific wallet
      const volume = await getVolume(token, wallet);
      return res.status(200).json({ token, wallet, volume });
    }

    if (token) {
      // Get all traders for token
      const traders = await getTradersByToken(token, parseFloat(minVolume || 0));
      return res.status(200).json({ token, traders, count: traders.length });
    }

    // Return stats
    const stats = {
      tokensTracked: 0,
      tokens: [],
      storage: hasKV ? 'kv' : 'memory'
    };

    if (hasKV) {
      try {
        const { kv } = require('@vercel/kv');
        const trackedTokens = await kv.smembers('trade_tokens');
        stats.tokensTracked = trackedTokens?.length || 0;

        for (const tokenAddr of trackedTokens || []) {
          const wallets = await kv.smembers(`trade_wallets_${tokenAddr}`);
          stats.tokens.push({
            address: tokenAddr,
            traderCount: wallets?.length || 0
          });
        }
      } catch (e) {
        console.log('KV stats failed, falling back to memory:', e.message);
      }
    }

    // If KV didn't work or not available, use memory
    if (stats.tokensTracked === 0) {
      stats.tokensTracked = tradeStoreMemory.size;
      for (const [tokenAddr, traders] of tradeStoreMemory) {
        stats.tokens.push({
          address: tokenAddr,
          traderCount: traders.size
        });
      }
    }

    return res.status(200).json(stats);
  }

  // POST: Receive webhook from Neynar
  if (req.method === 'POST') {
    // Get raw body for signature verification
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-neynar-signature'];
    const secret = process.env.NEYNAR_WEBHOOK_SECRET;

    // Verify signature
    if (!verifySignature(rawBody, signature, secret)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      const { type, data } = req.body;

      if (type !== 'trade.created') {
        console.log(`ℹ️ Ignoring event type: ${type}`);
        return res.status(200).json({ received: true, ignored: true });
      }

      // Process trade event
      // Expected data structure from Neynar:
      // {
      //   fid: number,
      //   trader_wallet: string,
      //   token_address: string,
      //   token_amount: string,
      //   usd_value: number,
      //   tx_hash: string,
      //   timestamp: number
      // }

      console.log(`\n📈 Trade webhook received:`);
      console.log(`   FID: ${data.fid}`);
      console.log(`   Wallet: ${data.trader_wallet}`);
      console.log(`   Token: ${data.token_address}`);
      console.log(`   Amount: ${data.token_amount}`);
      console.log(`   USD: $${data.usd_value}`);

      await storeTrade(data);

      return res.status(200).json({
        received: true,
        processed: true,
        storage: hasKV ? 'kv' : 'memory'
      });

    } catch (error) {
      console.error('Webhook processing error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK SETUP HELPER
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a trade webhook via Neynar API
 * Run this once to set up the webhook:
 *   NEYNAR_API_KEY=xxx node api/trade-webhook.js setup
 */
async function setupWebhook() {
  const apiKey = process.env.NEYNAR_API_KEY;
  const targetUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/trade-webhook`
    : 'https://frame-opal-eight.vercel.app/api/trade-webhook';

  if (!apiKey) {
    console.error('❌ NEYNAR_API_KEY required');
    return;
  }

  console.log('🔧 Setting up Neynar trade webhook...');
  console.log(`   Target URL: ${targetUrl}`);

  try {
    const response = await fetch('https://api.neynar.com/v2/farcaster/webhook/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        name: 'neynartodes-trade-tracker',
        url: targetUrl,
        subscription: {
          'trade.created': {
            // No filters = all trades on Base
            // Add filters if you want to limit:
            // fids: [1188162], // Only your FID
            // minimum_token_amount_usdc: 1 // Min $1 trades
          }
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Failed to create webhook:', error);
      return;
    }

    const data = await response.json();
    console.log('✅ Webhook created!');
    console.log('   Webhook ID:', data.webhook?.webhook_id);
    console.log('   Secret:', data.webhook?.secrets?.value);
    console.log('\n⚠️ Save the secret as NEYNAR_WEBHOOK_SECRET in your environment!');

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// CLI support
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'setup') {
    setupWebhook();
  } else {
    console.log('Usage:');
    console.log('  NEYNAR_API_KEY=xxx node api/trade-webhook.js setup');
  }
}
