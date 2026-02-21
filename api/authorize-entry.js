/**
 * Authorize Entry API
 *
 * Signs an authorization message for a contest entry after verifying:
 * 1. FID is valid and not blocked
 * 2. Entrant hasn't already entered this contest
 *
 * The signature is required by BuyBurnHoldEarnV3 — without it, the
 * contract reverts. This prevents sybil wallets from calling the
 * contract directly.
 *
 * POST /api/authorize-entry
 * Body: {
 *   fid: 12345,
 *   host: "0x...",
 *   entrantAddress: "0x...",
 *   contestId: "30"
 * }
 *
 * Returns: { success: true, v, r, s, nonce }
 */

const { ethers } = require('ethers');

// Blocked FIDs — synced from finalize-contest.js
const BLOCKED_FIDS = [
  1188162,  // brianwharton - app owner
  1891537,  // neynartodes - official account
  1990047,  // ropiik - scam token contests
  940217,   // futurepicker - suspected multi-account abuse
  874752,   // lunamarsh - suspected multi-account abuse
  1139990,  // sonite/bengarfm - suspected multi-account abuse
  2045016,  // aerieth - alt account of @aeri
  // Farm ring: all linked to X @nando8618, registered 2025-03-23
  1027658,  // iskaeth (Iska.eth)
  1027765,  // lokidtuyul
  1028120,  // shanksd
  1028226,  // badjul
  1028609,  // cekots
  1028738,  // tudyul
  1028891,  // potrgas
  1029130,  // jokod
  1029267,  // tuyuldportgas
  1029416,  // tahud
  1029631,  // tolod
  1029836,  // tahukrispi
  1029997,  // amod
  1030095,  // keere
  1030154,  // robertinus
  1030224,  // iisdah
  1030320,  // romad
  1030388,  // lemper
  1030464,  // dedibotak
  1030703,  // cekot
  1030791,  // bawi
  1030903,  // rugdpul
  1030963,  // rontok
  1031056,  // gombloh
  1031145,  // rokid
];

const BBHE_V3 = process.env.BBHE_V3_ADDRESS || '0x8340116C435307d90Df320d19F0871544653D232';
const RPC = 'https://mainnet.base.org';

const NONCE_ABI = ['function nonces(address) view returns (uint256)'];

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

  const { fid, host, entrantAddress, contestId } = req.body;

  // Validate inputs
  const parsedFid = parseInt(fid);
  if (!fid || isNaN(parsedFid) || parsedFid <= 0) {
    return res.status(400).json({ error: 'Missing or invalid fid' });
  }
  if (!host || !ethers.isAddress(host)) {
    return res.status(400).json({ error: 'Missing or invalid host address' });
  }
  if (!entrantAddress || !ethers.isAddress(entrantAddress)) {
    return res.status(400).json({ error: 'Missing or invalid entrant address' });
  }
  if (!contestId) {
    return res.status(400).json({ error: 'Missing contestId' });
  }

  // Check blocked FIDs
  if (BLOCKED_FIDS.includes(parsedFid)) {
    return res.status(403).json({ error: 'FID is blocked' });
  }

  // Check signer key is configured
  if (!process.env.ENTRY_SIGNER_KEY) {
    console.error('ENTRY_SIGNER_KEY not configured');
    return res.status(500).json({ error: 'Signing not configured' });
  }

  try {
    // Check if user already entered this contest (prevent double-signing)
    const { kv } = require('@vercel/kv');
    const existingEntry = await kv.get(`entry:${contestId}:${parsedFid}`);
    if (existingEntry) {
      return res.status(400).json({ error: 'Already entered this contest' });
    }

    // Read the current nonce from the V3 contract
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(BBHE_V3, NONCE_ABI, provider);
    const nonce = await contract.nonces(entrantAddress);

    // Sign the authorization message
    // Must match contract's _verifySig: keccak256(abi.encodePacked(entrant, host, nonce))
    const signerWallet = new ethers.Wallet(process.env.ENTRY_SIGNER_KEY);
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'address', 'uint256'],
      [entrantAddress, host, nonce]
    );
    const signature = await signerWallet.signMessage(ethers.getBytes(messageHash));
    const { v, r, s } = ethers.Signature.from(signature);

    console.log(`Authorization signed for FID ${parsedFid}, entrant ${entrantAddress}, contest ${contestId}`);

    return res.status(200).json({
      success: true,
      v,
      r,
      s,
      nonce: nonce.toString()
    });

  } catch (error) {
    console.error('Authorize entry error:', error);
    return res.status(500).json({ error: error.message });
  }
};
