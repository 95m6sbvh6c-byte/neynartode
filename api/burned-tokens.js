/**
 * Burned Tokens API
 *
 * Returns total NEYNARTODES tokens burned across all sources.
 * Cached in KV for 1 hour to avoid repeated on-chain calls.
 *
 * Usage:
 *   GET /api/burned-tokens
 */

const { ethers } = require('ethers');

const CONFIG = {
  NEYNARTODES_TOKEN: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  VOTING_MANAGER: '0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  BURN_ADDRESSES: [
    '0x000000000000000000000000000000000000dEaD',
    '0x0000000000000000000000000000000000000000',
  ],
  KV_KEY: 'burned_tokens_total',
  CACHE_TTL: 3600, // 1 hour
};

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const VM_ABI = ['function totalTokensBurned() view returns (uint256)'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Check KV cache first
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const cached = await kv.get(CONFIG.KV_KEY).catch(() => null);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    // Fetch from chain
    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
    const token = new ethers.Contract(CONFIG.NEYNARTODES_TOKEN, ERC20_ABI, provider);
    const vm = new ethers.Contract(CONFIG.VOTING_MANAGER, VM_ABI, provider);

    const [burnBalances, vmBurned] = await Promise.all([
      Promise.all(CONFIG.BURN_ADDRESSES.map(addr => token.balanceOf(addr).catch(() => 0n))),
      vm.totalTokensBurned().catch(() => 0n),
    ]);

    let totalBurned = 0n;
    for (const b of burnBalances) totalBurned += b;
    totalBurned += vmBurned;

    const result = {
      totalBurned: ethers.formatEther(totalBurned),
      vmBurned: ethers.formatEther(vmBurned),
      lastUpdated: new Date().toISOString(),
    };

    // Store in KV with 1 hour TTL
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      await kv.set(CONFIG.KV_KEY, result, { ex: CONFIG.CACHE_TTL });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('Burned tokens error:', error);
    return res.status(500).json({ error: error.message });
  }
};
