// Vercel Serverless Function - Check User Access
// This handles the "Check Access" button click

import { ethers } from 'ethers';

const CONTRACTS = {
  neynartodes: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  prizeNFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1', // V2 deployed 2025-12-01
};

const BASE_RPC = process.env.BASE_RPC_URL || 'https://rpc.ankr.com/base';

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse Farcaster Frame message
    const { untrustedData } = req.body;
    const fid = untrustedData?.fid;

    if (!fid) {
      return res.status(400).json({ error: 'No FID provided' });
    }

    // Fetch user's verified addresses from Neynar API
    const neynarResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      {
        headers: {
          'api_key': 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',
        },
      }
    );

    const neynarData = await neynarResponse.json();
    const user = neynarData.users?.[0];

    if (!user || !user.verified_addresses?.eth_addresses?.[0]) {
      return returnFrame(res, {
        image: generateAccessImage({
          status: '❌ No Verified Wallet',
          message: 'Please verify your wallet in Farcaster settings',
          balance: '0',
          hasAccess: false,
        }),
      });
    }

    const userAddress = user.verified_addresses.eth_addresses[0];

    // Check token balance on Base
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const tokenContract = new ethers.Contract(
      CONTRACTS.neynartodes,
      ['function balanceOf(address) external view returns (uint256)'],
      provider
    );

    const balance = await tokenContract.balanceOf(userAddress);
    const formatted = ethers.formatEther(balance);
    const balanceNum = parseFloat(formatted);

    // Check whitelist
    const prizeNFTContract = new ethers.Contract(
      CONTRACTS.prizeNFT,
      ['function whitelist(address) external view returns (bool)'],
      provider
    );

    const isWhitelisted = await prizeNFTContract.whitelist(userAddress);

    // Determine access
    const hasTokens = balanceNum >= 20000;
    const hasAccess = hasTokens && isWhitelisted;

    return returnFrame(res, {
      image: generateAccessImage({
        status: hasAccess ? '✅ Access Granted!' : '🚫 Access Denied',
        message: hasAccess
          ? 'You have Season 0 Beta access!'
          : !isWhitelisted
          ? 'Not whitelisted for Season 0'
          : 'Need 20K NEYNARTODES tokens',
        balance: balanceNum.toLocaleString(),
        hasAccess,
      }),
    });

  } catch (error) {
    console.error('Error checking access:', error);
    return res.status(500).json({ error: 'Failed to check access' });
  }
}

function generateAccessImage({ status, message, balance, hasAccess }) {
  const bgColor = hasAccess ? '#10b981' : '#ef4444';

  return `
    <svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="1200" fill="${bgColor}"/>

      <text x="600" y="300" font-family="Arial, sans-serif" font-size="80" font-weight="bold" text-anchor="middle" fill="white">
        ${status}
      </text>

      <rect x="200" y="400" width="800" height="400" rx="20" fill="rgba(255,255,255,0.2)"/>

      <text x="600" y="500" font-family="Arial, sans-serif" font-size="48" text-anchor="middle" fill="white">
        ${message}
      </text>

      <text x="600" y="600" font-family="Arial, sans-serif" font-size="36" text-anchor="middle" fill="white">
        Your Balance:
      </text>

      <text x="600" y="680" font-family="Arial, sans-serif" font-size="56" font-weight="bold" text-anchor="middle" fill="white">
        ${balance} NEYNARTODES
      </text>

      <text x="600" y="1000" font-family="Arial, sans-serif" font-size="32" text-anchor="middle" fill="white">
        ${hasAccess ? '🎮 Click "Launch App" to participate!' : '💰 Get more tokens or join whitelist'}
      </text>
    </svg>
  `;
}

function returnFrame(res, { image }) {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta property="fc:frame" content="vNext" />
        <meta property="fc:frame:image" content="data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}" />
        <meta property="fc:frame:button:1" content="🔄 Check Again" />
        <meta property="fc:frame:button:1:action" content="post" />
        <meta property="fc:frame:button:2" content="🎮 Launch App" />
        <meta property="fc:frame:button:2:action" content="link" />
        <meta property="fc:frame:button:2:target" content="https://neynartode.vercel.app/app" />
      </head>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}
