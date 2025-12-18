/**
 * Signer Create API
 *
 * Creates a Neynar managed signer for a user.
 * The user must then approve the signer via the returned URL.
 *
 * Requires environment variables:
 * - NEYNAR_API_KEY: Your Neynar API key
 * - APP_FID: Your app's Farcaster ID
 * - APP_MNEMONIC: Your app's custody address mnemonic (12/24 word phrase)
 *
 * Optional environment variables:
 * - NEYNAR_SPONSOR_SIGNERS: Set to "true" to have Neynar pay the signer registration fee
 *   (developer is charged in Neynar credits instead of user paying $1 onchain)
 *
 * POST /api/signer-create
 * Body: { fid: 12345 }
 *
 * Returns: { success: true, signer_uuid: "...", approval_url: "...", fid: 12345 }
 */

const { ethers } = require('ethers');

// Farcaster Signed Key Request typehash for EIP-712 signing
const SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10, // Optimism
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553'
};

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' }
];

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

  const { fid } = req.body;

  if (!fid) {
    return res.status(400).json({ error: 'Missing fid' });
  }

  const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
  if (!NEYNAR_API_KEY) {
    return res.status(500).json({ error: 'Neynar API key not configured' });
  }

  try {
    // Check if user already has an approved signer
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const existingSigner = await kv.get(`signer:${fid}`);

      if (existingSigner && existingSigner.approved) {
        return res.status(200).json({
          success: true,
          already_approved: true,
          signer_uuid: existingSigner.signer_uuid,
          fid
        });
      }

      // If there's a pending signer, check if it's valid
      if (existingSigner && !existingSigner.approved) {
        // Check if it's still valid (less than 24 hours old) and has a valid URL format
        const age = Date.now() - existingSigner.created_at;
        // Valid URLs are:
        // - farcaster://signed-key-request?token=... (deep link for mobile)
        // - https://client.farcaster.xyz/deeplinks/signed-key-request?token=... (web-accessible)
        // Invalid are the old warpcast.com/~/sign-in-with-farcaster URLs we incorrectly created
        const hasValidUrl = existingSigner.approval_url &&
          (existingSigner.approval_url.includes('farcaster://signed-key-request') ||
           existingSigner.approval_url.includes('client.farcaster.xyz/deeplinks/signed-key-request')) &&
          !existingSigner.approval_url.includes('warpcast.com/~/sign-in-with-farcaster');

        if (age < 24 * 60 * 60 * 1000 && hasValidUrl) {
          return res.status(200).json({
            success: true,
            pending: true,
            signer_uuid: existingSigner.signer_uuid,
            approval_url: existingSigner.approval_url,
            fid
          });
        }

        // Old signer has invalid URL format or is expired - delete it and create new one
        console.log(`Removing stale/invalid signer for FID ${fid}: age=${age}ms, url=${existingSigner.approval_url?.slice(0, 50)}`);
        await kv.del(`signer:${fid}`);
      }
    }

    // Check for required env vars
    const APP_FID = process.env.APP_FID;
    const APP_MNEMONIC = process.env.APP_MNEMONIC;

    if (!APP_FID || !APP_MNEMONIC) {
      console.error('Missing APP_FID or APP_MNEMONIC environment variables');
      return res.status(500).json({
        error: 'App not configured for signer creation',
        details: 'Missing APP_FID or APP_MNEMONIC'
      });
    }

    // Step 0: Verify custody address matches APP_FID
    const verifyWallet = ethers.Wallet.fromPhrase(APP_MNEMONIC);
    console.log(`Verifying custody address for APP_FID ${APP_FID}`);
    console.log(`Derived address from mnemonic: ${verifyWallet.address}`);

    // Fetch the actual custody address for APP_FID from Neynar
    const userResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${APP_FID}`,
      {
        method: 'GET',
        headers: { 'x-api-key': NEYNAR_API_KEY }
      }
    );

    if (userResponse.ok) {
      const userData = await userResponse.json();
      const appUser = userData.users?.[0];
      if (appUser) {
        console.log(`Registered custody address for FID ${APP_FID}: ${appUser.custody_address}`);
        if (appUser.custody_address?.toLowerCase() !== verifyWallet.address.toLowerCase()) {
          console.error('CUSTODY ADDRESS MISMATCH!');
          console.error(`Expected: ${appUser.custody_address}`);
          console.error(`Got from mnemonic: ${verifyWallet.address}`);
          return res.status(500).json({
            error: 'Custody address mismatch',
            details: `The mnemonic does not generate the custody address registered for FID ${APP_FID}. Expected: ${appUser.custody_address}, Got: ${verifyWallet.address}`
          });
        }
        console.log('Custody address verified successfully!');
      }
    }

    // Step 1: Create a new signer
    console.log(`Creating signer for FID ${fid}, API key prefix: ${NEYNAR_API_KEY.slice(0, 8)}...`);

    const createResponse = await fetch('https://api.neynar.com/v2/farcaster/signer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      }
    });

    if (!createResponse.ok) {
      const errorData = await createResponse.json().catch(() => ({}));
      console.error('Signer creation failed:', errorData);
      return res.status(500).json({
        error: 'Failed to create signer',
        details: errorData.message || createResponse.statusText
      });
    }

    const signerData = await createResponse.json();
    console.log('Created signer:', signerData.signer_uuid);
    console.log('Public key:', signerData.public_key);

    // Step 2: Sign the key request with app's custody address
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

    const signature = await verifyWallet.signTypedData(
      SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
      { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
      {
        requestFid: BigInt(APP_FID),
        key: signerData.public_key,
        deadline: BigInt(deadline)
      }
    );

    console.log('Generated signature for signed key request');

    // Step 3: Register the signed key with Neynar
    // Check if we should have Neynar sponsor the signer (pay the fee on behalf of user)
    const sponsorSigners = process.env.NEYNAR_SPONSOR_SIGNERS === 'true';

    const signedKeyBody = {
      signer_uuid: signerData.signer_uuid,
      app_fid: parseInt(APP_FID),
      deadline: deadline,
      signature: signature
    };

    // If sponsoring enabled, add the sponsor object so Neynar pays the registration fee
    // Developer is charged in Neynar credits instead of user paying $1 onchain
    if (sponsorSigners) {
      signedKeyBody.sponsor = {
        sponsored_by_neynar: true
      };
      console.log('Signer sponsorship enabled - Neynar will pay registration fee');
    }

    const signedKeyResponse = await fetch('https://api.neynar.com/v2/farcaster/signer/signed_key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      },
      body: JSON.stringify(signedKeyBody)
    });

    if (!signedKeyResponse.ok) {
      const errorData = await signedKeyResponse.json().catch(() => ({}));
      console.error('Signed key registration failed:', errorData);
      return res.status(500).json({
        error: 'Failed to register signed key',
        details: errorData.message || signedKeyResponse.statusText
      });
    }

    const signedKeyData = await signedKeyResponse.json();
    console.log('Signed key registered:', JSON.stringify(signedKeyData, null, 2));

    // Get the approval URL from the response
    const approval_url = signedKeyData.signer_approval_url;
    const isApproved = signedKeyData.status === 'approved';

    console.log('Approval URL:', approval_url);
    console.log('Is approved:', isApproved);

    if (!approval_url && !isApproved) {
      return res.status(500).json({
        error: 'No approval URL returned',
        details: 'Neynar did not return a signer_approval_url'
      });
    }

    // Store in KV
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      await kv.set(`signer:${fid}`, {
        signer_uuid: signerData.signer_uuid,
        public_key: signerData.public_key,
        approval_url,
        approved: isApproved,
        sponsored: sponsorSigners,
        created_at: Date.now()
      });
    }

    console.log(`Created managed signer for FID ${fid}:`, signerData.signer_uuid, 'approved:', isApproved, 'sponsored:', sponsorSigners);

    return res.status(200).json({
      success: true,
      signer_uuid: signerData.signer_uuid,
      approval_url,
      already_approved: isApproved,
      sponsored: sponsorSigners,
      fid
    });

  } catch (error) {
    console.error('Signer creation error:', error);
    return res.status(500).json({ error: error.message });
  }
};
