# Farcaster Mini App SDK & Neynar Integration Guide

## Overview

This document covers wallet integration for Farcaster Mini Apps, based on research from December 2025.

## Key Packages

| Package | Purpose |
|---------|---------|
| `@farcaster/miniapp-sdk` | Core Mini App SDK |
| `@farcaster/miniapp-wagmi-connector` | **NEW** Wagmi connector (use `farcasterMiniApp`) |
| `@farcaster/frame-wagmi-connector` | **OLD** Wagmi connector (use `farcasterFrame`) - being deprecated |

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
```

### IMPORTANT: verifiedAddresses NOT in SDK Context

The `verifiedAddresses` field is **NOT** part of the Mini App SDK context. This is from the old Frames v1 spec. To get a user's verified ETH addresses, you must query the Neynar API using their FID.

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

### Option 2: SDK Wallet Provider

```javascript
const provider = await sdk.wallet.getEthereumProvider();
const accounts = await provider.request({ method: 'eth_requestAccounts' });
const address = accounts[0];
```

**WARNING**: The SDK provider may return a Privy custody wallet instead of the user's primary wallet in some configurations.

## Wagmi Integration

### New Connector (Recommended)

```javascript
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector';
import { createConfig, http } from '@wagmi/core';
import { base } from '@wagmi/core/chains';

const config = createConfig({
  chains: [base],
  connectors: [farcasterMiniApp()],
  transports: {
    [base.id]: http()
  }
});
```

### Old Connector (Still Works)

```javascript
import { farcasterFrame } from '@farcaster/frame-wagmi-connector';

const config = createConfig({
  chains: [base],
  connectors: [farcasterFrame()],
  transports: {
    [base.id]: http()
  }
});
```

## Sending Transactions

### Via SDK Provider

```javascript
const provider = await sdk.wallet.getEthereumProvider();
const txHash = await provider.request({
  method: 'eth_sendTransaction',
  params: [{
    from: userAddress,
    to: contractAddress,
    value: '0x8E1BC9BF040000', // 0.0025 ETH in hex
    data: '0x...', // Contract call data
    gas: '0x7A120' // Gas limit in hex
  }]
});
```

### Via Wagmi

```javascript
import { sendTransaction, parseEther } from '@wagmi/core';

const hash = await sendTransaction(config, {
  to: contractAddress,
  value: parseEther('0.0025'),
  data: '0x...',
});
```

## Privy Integration Notes

From Privy docs:
- **Automatic embedded wallet creation is NOT supported** for Farcaster Mini Apps
- Use the wallet automatically injected by Farcaster/Base App clients (recommended)
- If you see a Privy "custody wallet" being used, this is Privy's embedded wallet, NOT the user's primary wallet

## Common Issues

### Issue: Getting Privy Custody Wallet Instead of User's Wallet

**Symptoms**:
- `sdk.wallet.getEthereumProvider()` returns an address like `0xAB4F21321A7...`
- Console shows `Embedded1193Provider.request()`
- Balance is 0 because it's an empty custody wallet

**Solution**:
1. Fetch user's verified address from Neynar API using their FID
2. Use that address for the `from` field in transactions
3. The transaction will still go through the SDK provider, but with the correct `from` address

### Issue: Transaction Reverts

**Possible Causes**:
- Wrong `from` address (custody wallet has no funds)
- Insufficient gas limit
- Contract function requirements not met

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
- [dTech - Wagmi Wallet Connect in Mini Apps](https://dtech.vision/farcaster/miniapps/howtodowagmiwalletconnectinfarcasterminiapps/)
