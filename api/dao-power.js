/**
 * DAO Voting Power API
 *
 * Calculates a user's voting power for the Todely Awesome DAO.
 * Power is based on ecosystem participation (max 3):
 *   +1: Hold 100M+ NEYNARTODES (required)
 *   +1: Has ever hosted a contest
 *   +1: Has ever voted on the leaderboard
 *
 * GET /api/dao-power?fid=12345
 */

const { ethers } = require('ethers');
const { getUserAddresses: getCachedUserAddresses, getUserByFid } = require('./lib/utils');
const { CONFIG } = require('./lib/config');

const VOTING_MANAGER = '0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB';
const HOLDER_THRESHOLD = 100000000n * 10n ** 18n; // 100M tokens

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const VOTING_MANAGER_ABI = ['function voteRecords(address) view returns (uint256 lastVoteDay, uint256 votesUsedToday)'];

/**
 * Check if any of the user's addresses hold 100M+ NEYNARTODES
 */
async function checkHolder(addresses, provider) {
  if (addresses.length === 0) return { met: false, balance: '0' };

  const token = new ethers.Contract(CONFIG.NEYNARTODES, ERC20_ABI, provider);
  let totalBalance = 0n;

  for (const addr of addresses) {
    try {
      const bal = await token.balanceOf(addr);
      totalBalance += BigInt(bal.toString());
    } catch (e) {
      console.log(`Balance check failed for ${addr}:`, e.message);
    }
  }

  const balanceInTokens = totalBalance / (10n ** 18n);
  return {
    met: totalBalance >= HOLDER_THRESHOLD,
    balance: balanceInTokens.toString()
  };
}

/**
 * Check if any of the user's addresses have hosted a contest
 */
async function checkHosted(addresses) {
  if (addresses.length === 0) return { met: false, contestCount: 0 };

  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://frame-opal-eight.vercel.app';

    for (const addr of addresses) {
      const response = await fetch(`${baseUrl}/api/contest-history?host=${addr}&limit=1`);
      if (response.ok) {
        const data = await response.json();
        if (data.contests && data.contests.length > 0) {
          return { met: true, contestCount: data.contests.length };
        }
      }
    }
  } catch (e) {
    console.log('Contest hosting check failed:', e.message);
  }

  return { met: false, contestCount: 0 };
}

/**
 * Check if any of the user's addresses have voted on the leaderboard
 */
async function checkVoted(addresses, provider) {
  if (addresses.length === 0) return { met: false };

  const votingManager = new ethers.Contract(VOTING_MANAGER, VOTING_MANAGER_ABI, provider);

  for (const addr of addresses) {
    try {
      const record = await votingManager.voteRecords(addr);
      if (BigInt(record.lastVoteDay.toString()) > 0n) {
        return { met: true };
      }
    } catch (e) {
      console.log(`Vote check failed for ${addr}:`, e.message);
    }
  }

  return { met: false };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { fid } = req.query;
  if (!fid) return res.status(400).json({ error: 'Missing fid' });

  // Check KV cache first (5 min TTL)
  let kv = null;
  if (process.env.KV_REST_API_URL) {
    try {
      kv = require('@vercel/kv').kv;
      const cached = await kv.get(`dao:power:${fid}`);
      if (cached) {
        return res.status(200).json(cached);
      }
    } catch (e) {
      console.log('KV cache miss:', e.message);
    }
  }

  try {
    // Get user's verified addresses
    const addresses = await getCachedUserAddresses(parseInt(fid));
    if (addresses.length === 0) {
      return res.status(200).json({ power: 0, maxPower: 3, breakdown: {
        holder: { met: false, balance: '0' },
        hosted: { met: false, contestCount: 0 },
        voted: { met: false }
      }});
    }

    const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

    // Run all checks in parallel
    const [holder, hosted, voted] = await Promise.all([
      checkHolder(addresses, provider),
      checkHosted(addresses),
      checkVoted(addresses, provider)
    ]);

    // Must be a holder to have any power
    let power = 0;
    if (holder.met) {
      power = 1;
      if (hosted.met) power++;
      if (voted.met) power++;
    }

    const result = {
      power,
      maxPower: 3,
      breakdown: { holder, hosted, voted }
    };

    // Cache for 5 min
    if (kv) {
      try {
        await kv.set(`dao:power:${fid}`, result, { ex: 300 });
      } catch (e) {
        console.log('KV cache set failed:', e.message);
      }
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('DAO power check error:', error);
    return res.status(500).json({ error: 'Failed to check voting power' });
  }
};
