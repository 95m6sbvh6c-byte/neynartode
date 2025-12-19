/**
 * Frame Action API
 *
 * Handles "Enter Raffle" button click from Farcaster Frame.
 * For holders: directly processes entry (like, recast, record)
 * For non-holders: returns transaction request for wash trade
 *
 * POST /api/frame-action?contestId=30
 * Body: Farcaster Frame action payload
 *
 * Returns: Transaction frame or success frame
 */

const { ethers } = require('ethers');

const CONFIG = {
  BASE_RPC_URL: 'https://mainnet.base.org',
  NEYNARTODES_TOKEN: '0x8de1622fe07f56CDA2E2273e615a513f1D828b07',
  HOLDER_THRESHOLD: '100000000', // 100M tokens
  WASH_TRADER_ADDRESS: '0x2f4132d2b6f915beefccacb64eef115c5bc95a7e', // WashTraderV4ETH with Permit2
  WASH_TRADE_FEE: '0.0025' // ETH
};

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://frame-opal-eight.vercel.app';

async function checkIsHolder(addresses) {
  if (!addresses || addresses.length === 0) return false;

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC_URL);
  const token = new ethers.Contract(CONFIG.NEYNARTODES_TOKEN, ERC20_ABI, provider);

  const threshold = ethers.parseUnits(CONFIG.HOLDER_THRESHOLD, 18);

  const balances = await Promise.all(
    addresses.map(addr => token.balanceOf(addr).catch(() => 0n))
  );

  const totalBalance = balances.reduce((sum, bal) => sum + BigInt(bal), 0n);
  return totalBalance >= threshold;
}

async function getUserAddresses(fid) {
  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) return [];

  const response = await fetch(
    `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
    {
      headers: { 'api_key': NEYNAR_API_KEY }
    }
  );

  if (!response.ok) return [];

  const data = await response.json();
  const user = data.users?.[0];
  if (!user) return [];

  return user.verified_addresses?.eth_addresses || [];
}

async function processEntry(fid, contestId, castHash, addresses) {
  // Call enter-contest API internally
  const { kv } = require('@vercel/kv');

  // Get user's signer
  const signerData = await kv.get(`signer:${fid}`);
  if (!signerData || !signerData.approved) {
    return { success: false, error: 'No approved signer' };
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

  // Post like
  await fetch('https://api.neynar.com/v2/farcaster/reaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_key': NEYNAR_API_KEY
    },
    body: JSON.stringify({
      signer_uuid: signerData.signer_uuid,
      reaction_type: 'like',
      target: castHash
    })
  });

  // Post recast
  await fetch('https://api.neynar.com/v2/farcaster/reaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_key': NEYNAR_API_KEY
    },
    body: JSON.stringify({
      signer_uuid: signerData.signer_uuid,
      reaction_type: 'recast',
      target: castHash
    })
  });

  // Record entry
  const entry = {
    fid: parseInt(fid),
    contestId: contestId.toString(),
    addresses,
    timestamp: Date.now(),
    hasReplied: false,
    enteredAt: new Date().toISOString(),
    source: 'frame'
  };

  await kv.set(`entry:${contestId}:${fid}`, entry);
  await kv.sadd(`contest_entries:${contestId}`, fid.toString());

  return { success: true };
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

  const { contestId } = req.query;
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  try {
    // Parse Frame action payload
    const { untrustedData, trustedData } = req.body;

    if (!untrustedData) {
      return res.status(400).json({ error: 'Invalid frame action' });
    }

    const fid = untrustedData.fid;
    const castHash = untrustedData.castId?.hash;

    if (!fid) {
      return res.status(400).json({ error: 'Missing fid in frame action' });
    }

    // Check if already entered
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const existingEntry = await kv.get(`entry:${contestId}:${fid}`);

      if (existingEntry) {
        // Already entered - return success frame
        const imageUrl = `${BASE_URL}/api/frame-image?contestId=${contestId}&status=entered&t=${Date.now()}`;

        return res.status(200).json({
          type: 'frame',
          frameUrl: `${BASE_URL}/api/frame?contestId=${contestId}&status=entered`,
          image: imageUrl,
          buttons: [
            {
              label: 'Entered ✓',
              action: 'post'
            }
          ]
        });
      }
    }

    // Get user's addresses
    const addresses = await getUserAddresses(fid);

    // Check if user is holder
    const isHolder = await checkIsHolder(addresses);

    if (isHolder) {
      // Holder: Process entry directly (like, recast, record)
      const result = await processEntry(fid, contestId, castHash, addresses);

      if (result.success) {
        const imageUrl = `${BASE_URL}/api/frame-image?contestId=${contestId}&status=entered&t=${Date.now()}`;

        return res.status(200).json({
          type: 'frame',
          frameUrl: `${BASE_URL}/api/frame?contestId=${contestId}&status=entered`,
          image: imageUrl,
          buttons: [
            {
              label: 'Entered ✓',
              action: 'post'
            }
          ]
        });
      } else {
        // Failed - need signer approval
        return res.status(200).json({
          type: 'frame',
          frameUrl: `${BASE_URL}/api/frame?contestId=${contestId}&status=needs_signer`,
          image: `${BASE_URL}/api/frame-image?contestId=${contestId}&status=needs_signer`,
          buttons: [
            {
              label: 'Authorize App First',
              action: 'link',
              target: `https://farcaster.xyz/miniapps/neynartodes?action=authorize`
            }
          ]
        });
      }

    } else {
      // Non-holder: Return transaction request for wash trade
      const washTradeValue = ethers.parseEther(CONFIG.WASH_TRADE_FEE);

      // washTrade() function selector - no parameters needed
      const washTradeSelector = ethers.id('washTrade()').slice(0, 10);

      // Return transaction frame
      return res.status(200).json({
        chainId: 'eip155:8453', // Base mainnet
        method: 'eth_sendTransaction',
        params: {
          to: CONFIG.WASH_TRADER_ADDRESS,
          value: washTradeValue.toString(),
          data: washTradeSelector
        }
      });
    }

  } catch (error) {
    console.error('Frame action error:', error);
    return res.status(500).json({ error: error.message });
  }
};
