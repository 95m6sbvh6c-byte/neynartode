# Farcaster Mini App SDK & Neynar Integration Guide

## Overview

This document covers wallet integration for Farcaster Mini Apps, based on research from December 2025.

## Key Packages

| Package | Purpose |
|---------|---------|
| `@farcaster/miniapp-sdk` | Core Mini App SDK |
| `@farcaster/miniapp-wagmi-connector` | Wagmi connector (use `farcasterMiniApp()`) |

> **DEPRECATED**: `@farcaster/frame-wagmi-connector` is deprecated. Migrate to `@farcaster/miniapp-wagmi-connector`.

## SDK Context Structure

The `sdk.context` object provides session info when a mini app opens:

```javascript
const context = await sdk.context;

// context.user structure:
{
  fid: 6841,                    // Farcaster ID
  username: "deodad",           // Optional
  displayName: "Tony D'Addeo",  // Optional
  pfpUrl: "https://...",        // Optional
  bio: "...",                   // Optional
  location: {                   // Optional
    placeId: "...",
    description: "Austin, TX"
  }
}

// context.client structure:
{
  platformType: 'web' | 'mobile',
  clientFid: 12345,             // Client's self-reported FID
  added: true,                  // Whether user added the Mini App
  safeAreaInsets: {             // Padding for mobile nav
    top: 0, bottom: 0, left: 0, right: 0
  },
  notificationDetails: {        // Optional - for sending notifications
    url: "...",
    token: "..."
  }
}

// context.location - where app was opened from:
// - cast embed, cast share, notification, launcher, channel, or inter-app navigation
```

> **WARNING**: Context data should be considered **untrusted** since it is passed in by the client application.

### IMPORTANT: verifiedAddresses NOT in SDK Context

The `verifiedAddresses` field is **NOT** part of the Mini App SDK context. This was from the old Frames v1 spec. To get a user's verified ETH addresses, you must query the Neynar API using their FID.

## Getting User's Verified Wallet Addresses

### Option 1: Neynar API (Recommended)

```javascript
// Fetch user's verified addresses via Neynar API
const fid = context.user.fid;
const response = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
  headers: {
    'api_key': 'YOUR_NEYNAR_API_KEY'
  }
});
const data = await response.json();
const user = data.users[0];

// User object contains:
// - custody_address: The FID's custody address
// - verified_addresses: { eth_addresses: [...], sol_addresses: [...] }
const ethAddresses = user.verified_addresses.eth_addresses;
const primaryAddress = ethAddresses[0];
```

### Option 2: Wagmi useAccount Hook

```javascript
import { useAccount } from 'wagmi';

function MyComponent() {
  const { address, isConnected } = useAccount();
  // address is the connected wallet address
}
```

### Option 3: SDK Wallet Provider (Caution)

```javascript
const provider = await sdk.wallet.getEthereumProvider();
const accounts = await provider.request({ method: 'eth_requestAccounts' });
const address = accounts[0];
```

> **WARNING**: The SDK provider may return a Privy custody wallet instead of the user's primary wallet. Use Neynar API or wagmi's useAccount for reliable address retrieval.

## Wagmi Integration

### Recommended Setup

```javascript
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector';
import { createConfig, http } from '@wagmi/core';
import { base } from '@wagmi/core/chains';

// IMPORTANT: Instantiate connector ONCE and reuse it
const connector = farcasterMiniApp();

const config = createConfig({
  chains: [base],
  connectors: [connector],
  transports: {
    [base.id]: http()
  }
});
```

> **Key Point**: If a user already has a connected wallet, the connector will automatically connect to it.

## Sending Transactions

### Via Wagmi (Recommended)

```javascript
import { sendTransaction } from '@wagmi/core';

const hash = await sendTransaction(config, {
  to: contractAddress,
  value: BigInt('2500000000000000'), // 0.0025 ETH in wei
  data: '0x...',
});
```

### Batch Transactions with useSendCalls

For better UX, combine multiple operations (like "approve and swap") in one step:

```javascript
import { useSendCalls } from 'wagmi/experimental';

const { sendCalls } = useSendCalls();

// Batch multiple calls
await sendCalls({
  calls: [
    { to: tokenAddress, data: approveData },
    { to: swapAddress, data: swapData }
  ]
});
```

> **Note**: Batched transactions are individually validated and scanned for security. They execute sequentially, not atomically.

### Via SDK Provider

```javascript
const provider = await sdk.wallet.getEthereumProvider();
const txHash = await provider.request({
  method: 'eth_sendTransaction',
  params: [{
    to: contractAddress,
    value: '0x8E1BC9BF040000', // 0.0025 ETH in hex
    data: '0x...'
  }]
});
```

> **Note**: Omit the `from` field to let the provider use the connected wallet. Omit `gas` to let the provider estimate.

## Common Issues

### Issue: Getting Privy Custody Wallet Instead of User's Wallet

**Symptoms**:
- `sdk.wallet.getEthereumProvider()` returns an unexpected address
- Console shows `Embedded1193Provider.request()`
- Balance is 0 because it's an empty custody wallet

**Solution**:
1. Use wagmi's `farcasterMiniApp()` connector instead of SDK provider
2. Fetch user's verified address from Neynar API using their FID
3. Ensure you're using a single connector instance (don't create new instances per request)

### Issue: Transaction Reverts

**Possible Causes**:
- Wrong wallet being used (custody wallet has no funds)
- Insufficient gas limit
- Contract function requirements not met

### Issue: Connector Deprecation Warning

If you see: `[DEPRECATION WARNING] @farcaster/frame-wagmi-connector is deprecated`

**Solution**: Migrate to `@farcaster/miniapp-wagmi-connector`:
```javascript
// OLD (deprecated)
import { farcasterFrame } from '@farcaster/frame-wagmi-connector';

// NEW (use this)
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector';
```

## Neynar Managed Signers

Signers allow your app to perform actions (like, recast, cast) on behalf of users.

### Signer Approval Flow

1. **Create signer**: `POST /v2/farcaster/signer` - Get signer_uuid and public_key
2. **Sign the request**: Use EIP-712 to sign with your app's custody address
3. **Register signed key**: `POST /v2/farcaster/signer/signed_key` - Get approval_url
4. **User approves**: User clicks approval URL to authorize in Farcaster app
5. **Poll for approval**: `GET /v2/farcaster/signer?signer_uuid=...` until status is "approved"
6. **Use signer**: Pass signer_uuid to write APIs

### Mobile vs Desktop Handling

**CRITICAL**: On mobile, do NOT show a QR code - users can't scan their own screen!

```javascript
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

if (isMobile) {
  // Direct link to Farcaster app (deep link)
  // Do NOT use target="_blank" - it can break deep links
  return `<a href="${approval_url}">Open in Farcaster App</a>`;
} else {
  // Desktop: Show QR code for user to scan with phone
  return `<div id="qrcode"></div>`;
  new QRCode(document.getElementById('qrcode'), approval_url);
}
```

### Approval URL Formats

The API returns URLs in these formats:
- Deep link: `farcaster://signed-key-request?token=0x...`
- Web link: `https://client.farcaster.xyz/deeplinks/signed-key-request?token=...`

Both work, but deep links are preferred for mobile.

### Signer Status States

| Status | Meaning |
|--------|---------|
| `generated` | Signer created, not yet signed |
| `pending_approval` | Signed and waiting for user approval |
| `approved` | User approved, ready to use |
| `revoked` | User revoked the signer |

### Sponsored Signers

You can have Neynar pay the signer registration fee (charged to your Neynar credits):

```javascript
const signedKeyBody = {
  signer_uuid: signerData.signer_uuid,
  app_fid: parseInt(APP_FID),
  deadline: deadline,
  signature: signature,
  sponsor: {
    sponsored_by_neynar: true  // Neynar pays the $1 fee
  }
};
```

## API Endpoints

### Neynar User Lookup

```
GET https://api.neynar.com/v2/farcaster/user/bulk?fids={fid}
Headers: api_key: YOUR_API_KEY

Response:
{
  users: [{
    fid: 1234,
    username: "...",
    custody_address: "0x...",
    verified_addresses: {
      eth_addresses: ["0x...", "0x..."],
      sol_addresses: []
    }
  }]
}
```

### Neynar User by Custody Address

```
GET https://api.neynar.com/v2/farcaster/user/custody-address?custody_address={address}
```

### Neynar User by ETH Address

```
GET https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses={address}
```

## Sources

- [Farcaster Mini Apps - Wallet](https://miniapps.farcaster.xyz/docs/sdk/wallet)
- [Farcaster Mini Apps - Wallets Guide](https://miniapps.farcaster.xyz/docs/guides/wallets)
- [Farcaster Mini Apps - Context](https://miniapps.farcaster.xyz/docs/sdk/context)
- [Neynar - Convert Web App to Mini App](https://neynar.mintlify.app/docs/convert-web-app-to-mini-app)
- [Privy - Farcaster Mini Apps](https://docs.privy.io/recipes/farcaster/mini-apps)
- [@farcaster/miniapp-wagmi-connector NPM](https://www.npmjs.com/package/@farcaster/miniapp-wagmi-connector)
- [Farcaster Mini Apps GitHub](https://github.com/farcasterxyz/miniapps)
