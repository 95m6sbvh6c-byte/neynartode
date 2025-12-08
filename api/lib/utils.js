/**
 * Shared utility functions for all API endpoints
 * Eliminates duplicate code across files
 */

const { CONFIG } = require('./config');

// ═══════════════════════════════════════════════════════════════════
// CACHING
// ═══════════════════════════════════════════════════════════════════

// Simple in-memory cache with TTL
const cache = new Map();

function getCached(key, ttlMs = 60000) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttlMs) {
    return entry.value;
  }
  return null;
}

function setCache(key, value, ttlMs = 60000) {
  cache.set(key, { value, timestamp: Date.now() });
  // Cleanup old entries periodically
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.timestamp > ttlMs * 2) {
        cache.delete(k);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// NEYNAR API HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Make a Neynar API GET request with caching
 */
async function neynarGet(endpoint, cacheTtlMs = 30000) {
  const cacheKey = `neynar:${endpoint}`;
  const cached = getCached(cacheKey, cacheTtlMs);
  if (cached) return cached;

  const res = await fetch(`https://api.neynar.com/v2/farcaster/${endpoint}`, {
    headers: { 'api_key': CONFIG.NEYNAR_API_KEY }
  });

  if (!res.ok) {
    throw new Error(`Neynar error: ${res.status}`);
  }

  const data = await res.json();
  setCache(cacheKey, data, cacheTtlMs);
  return data;
}

/**
 * Get Farcaster user by wallet address
 * @param {string} walletAddress - Ethereum address
 * @returns {Object|null} User object or null
 */
async function getUserByWallet(walletAddress) {
  if (!walletAddress || walletAddress === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  const cacheKey = `user:wallet:${walletAddress.toLowerCase()}`;
  const cached = getCached(cacheKey, 300000); // 5 min cache
  if (cached !== null) return cached;

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${walletAddress}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) {
      setCache(cacheKey, null, 60000);
      return null;
    }

    const data = await response.json();
    const users = Object.values(data || {}).flat();
    const user = users[0] || null;

    setCache(cacheKey, user, 300000);
    return user;
  } catch (error) {
    console.error('Error fetching user by wallet:', error.message);
    return null;
  }
}

/**
 * Get user addresses from FID
 * @param {number} fid - Farcaster ID
 * @returns {string[]} Array of lowercase addresses
 */
async function getUserAddresses(fid) {
  const cacheKey = `user:addresses:${fid}`;
  const cached = getCached(cacheKey, 300000);
  if (cached) return cached;

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      { headers: { 'api_key': CONFIG.NEYNAR_API_KEY } }
    );

    if (!response.ok) return [];

    const data = await response.json();
    const user = data.users?.[0];
    if (!user) return [];

    const addresses = [];
    if (user.custody_address) {
      addresses.push(user.custody_address.toLowerCase());
    }
    if (user.verified_addresses?.eth_addresses) {
      addresses.push(...user.verified_addresses.eth_addresses.map(a => a.toLowerCase()));
    }

    setCache(cacheKey, addresses, 300000);
    return addresses;
  } catch (e) {
    return [];
  }
}

/**
 * Get FID from wallet address
 * @param {string} address - Ethereum address
 * @returns {number|null} FID or null
 */
async function getFidFromAddress(address) {
  const user = await getUserByWallet(address);
  return user?.fid || null;
}

// ═══════════════════════════════════════════════════════════════════
// SOCIAL REQUIREMENTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse social requirements from castId string
 * Format: "castHash|R1L0P1" or "castHash|R1L0P1|imageUrl"
 * @param {string} castId - Full castId string from contract
 * @returns {Object} Parsed requirements
 */
function parseRequirements(castId) {
  const result = {
    castHash: castId,
    requireRecast: true,
    requireLike: false,
    requireReply: true,
    imageUrl: null,
  };

  if (!castId.includes('|')) {
    return result;
  }

  const parts = castId.split('|');
  result.castHash = parts[0];

  const reqCode = parts[1];
  if (reqCode) {
    const match = reqCode.match(/R(\d+)L(\d+)P(\d+)/);
    if (match) {
      result.requireRecast = parseInt(match[1]) > 0;
      result.requireLike = parseInt(match[2]) > 0;
      result.requireReply = parseInt(match[3]) > 0;
    }
  }

  if (parts[2]) {
    result.imageUrl = parts[2];
  }

  return result;
}

/**
 * Encode social requirements to string
 * @param {boolean} recast - Require recast
 * @param {boolean} like - Require like
 * @param {boolean} reply - Require reply
 * @returns {string} Encoded string like "R1L0P1"
 */
function encodeRequirements(recast, like, reply) {
  return `R${recast ? 1 : 0}L${like ? 1 : 0}P${reply ? 1 : 0}`;
}

// ═══════════════════════════════════════════════════════════════════
// ADDRESS UTILITIES
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize address to lowercase
 */
function normalizeAddress(address) {
  return address?.toLowerCase() || null;
}

/**
 * Check if address is zero address
 */
function isZeroAddress(address) {
  return !address || address === '0x0000000000000000000000000000000000000000';
}

/**
 * Deduplicate array of addresses (case-insensitive)
 */
function dedupeAddresses(addresses) {
  const seen = new Set();
  return addresses.filter(addr => {
    const lower = addr.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
// RANDOM SELECTION (Fisher-Yates)
// ═══════════════════════════════════════════════════════════════════

/**
 * Shuffle array using Fisher-Yates algorithm (unbiased)
 * @param {Array} array - Array to shuffle
 * @returns {Array} New shuffled array
 */
function shuffleArray(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

/**
 * Simple delay function for rate limiting
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate-limited fetch with retry
 */
async function rateLimitedFetch(url, options, retries = 3, delayMs = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        // Rate limited, wait and retry
        await delay(delayMs * Math.pow(2, i));
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(delayMs * Math.pow(2, i));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONTEST UTILITIES
// ═══════════════════════════════════════════════════════════════════

/**
 * Get contest status name
 */
function getStatusName(status) {
  const names = ['Active', 'PendingVRF', 'Completed', 'Cancelled'];
  return names[Number(status)] || 'Unknown';
}

/**
 * Format prize amount for display
 */
function formatPrizeAmount(amount, decimals = 18) {
  const value = Number(amount) / Math.pow(10, decimals);
  if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(2) + 'K';
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.001) return value.toFixed(4);
  return value.toFixed(6);
}

module.exports = {
  // Caching
  getCached,
  setCache,

  // Neynar
  neynarGet,
  getUserByWallet,
  getUserAddresses,
  getFidFromAddress,

  // Requirements
  parseRequirements,
  encodeRequirements,

  // Addresses
  normalizeAddress,
  isZeroAddress,
  dedupeAddresses,

  // Random
  shuffleArray,

  // Rate limiting
  delay,
  rateLimitedFetch,

  // Contest
  getStatusName,
  formatPrizeAmount,
};
