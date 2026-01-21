# NEYNARtodes Contract Registry

> Last Updated: January 20, 2026
> Network: Base Mainnet (Chain ID: 8453)

## Active Contracts (Season 0 Beta)

| Contract | Address | Version | Deployed |
|----------|---------|---------|----------|
| **NEYNARTODES Token** | `0x8de1622fe07f56cda2e2273e615a513f1d828b07` | - | Launch |
| **Contest Escrow (ETH)** | `0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A` | V1 | 2025-11-28 |
| **NFT Contest Escrow** | `0xFD6e84d4396Ecaa144771C65914b2a345305F922` | V3 | 2025-12-05 |
| **Prize NFT Season 0** | `0x54E3972839A79fB4D1b0F70418141723d02E56e1` | V2 | 2025-12-01 |
| **Voting Manager** | `0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB` | V3 | 2026-01-20 |
| **Treasury** | `0xd4d84f3477eb482783aAB48F00e357C801c48928` | V2 | 2025-12-01 |
| **Captain Hook** | `0x38A6C6074f4E14c82dB3bdDe4cADC7Eb2967fa9B` | V2 | 2025-11-XX |
| **Clanker Collector** | `0xAcFC2aD738599f5E5F0B90B11774b279eb2CF280` | V2 | 2025-11-XX |

---

## Contract Descriptions

### NEYNARTODES Token
- **Type**: ERC-20 (Clanker-deployed)
- **Purpose**: Native platform token for voting, staking, and prizes
- **Features**:
  - Deflationary via burn mechanics
  - Used for voting (1000 tokens per vote)
  - Prize token for contests

### Contest Escrow (ETH)
- **Type**: ERC-20 prize custody + VRF winner selection
- **Purpose**: Trustless contest management for token prizes with Chainlink VRF
- **Features**:
  - Holds ERC-20 prizes in escrow until contest ends
  - Integrates with Chainlink VRF v2.5 for random winner selection
  - Supports any ERC-20 token on Base
  - Automatic prize distribution to winners

### NFT Contest Escrow
- **Type**: NFT prize custody + VRF winner selection
- **Purpose**: Trustless NFT contest management with Chainlink VRF
- **Features**:
  - Holds ERC-721 NFTs in escrow until contest ends
  - Supports two-step flow for restricted NFTs
  - Integrates with Chainlink VRF v2.5 for random winner selection
  - Automatic NFT transfer to winner upon completion

### Prize NFT Season 0
- **Type**: Season rewards manager
- **Purpose**: Manages seasonal prize pools and distributions
- **Features**:
  - Tracks host and voter prize pools
  - Distributes end-of-season rewards
  - Supports ETH, ERC-20, and ERC-721 prizes

### Voting Manager
- **Type**: On-chain voting system
- **Purpose**: Enables community voting on hosts
- **Features**:
  - Upvote/downvote hosts on leaderboard
  - 100,000 NEYNARTODES per vote (adjustable by owner)
  - 50% burned, 50% to treasury
  - 10 votes per day per wallet
  - Vote scores affect host rankings

### Treasury
- **Type**: Protocol treasury
- **Purpose**: Central fund management
- **Features**:
  - Receives 50% of voting fees
  - Funds VRF subscriptions
  - Manages protocol operations

### Captain Hook
- **Type**: Automated liquidity compounder
- **Purpose**: Collects and compounds trading fees
- **Features**:
  - Collects LP fees from Uniswap pools
  - Compounds back into liquidity
  - Triggers automatically via Clanker Collector

### Clanker Collector
- **Type**: Fee collection router
- **Purpose**: Routes Clanker creator fees
- **Features**:
  - Collects creator fees from Clanker
  - 50% to treasury, 50% to recipient
  - Triggers Captain Hook for compounding

---

## External Dependencies

| Service | Purpose | Network |
|---------|---------|---------|
| **Chainlink VRF v2.5** | Verifiable random number generation | Base Mainnet |
| **Uniswap V3** | Token swaps and liquidity | Base Mainnet |
| **Neynar API** | Farcaster user data | API |
| **Alchemy RPC** | Blockchain data access | Base Mainnet |

---

## Verification Links

All contracts are verified on BaseScan:

- [NEYNARTODES Token](https://basescan.org/token/0x8de1622fe07f56cda2e2273e615a513f1d828b07)
- [Contest Escrow (ETH)](https://basescan.org/address/0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A)
- [NFT Contest Escrow](https://basescan.org/address/0xFD6e84d4396Ecaa144771C65914b2a345305F922)
- [Prize NFT Season 0](https://basescan.org/address/0x54E3972839A79fB4D1b0F70418141723d02E56e1)
- [Voting Manager](https://basescan.org/address/0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB)
- [Treasury](https://basescan.org/address/0xd4d84f3477eb482783aAB48F00e357C801c48928)

---

## Deprecated Contracts

| Contract | Address | Status |
|----------|---------|--------|
| PrizeNFT V1 | `0x82f5A8CEffce9419886Bb0644FA5D3FB8295Ab81` | Replaced by V2 |
| VotingManager V1 | `0xFF730AB8FaBfc432c513C57bE8ce377ac77eEc99` | Replaced by V2 |
| VotingManager V2 | `0x267Bd7ae64DA1060153b47d6873a8830dA4236f8` | Replaced by V3 |

---

## Quick Reference

```javascript
// For use in app.html or scripts
const CONTRACTS = {
  neynartodes: '0x8de1622fe07f56cda2e2273e615a513f1d828b07',
  contestEscrow: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  nftContestEscrow: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  prizeNFT: '0x54E3972839A79fB4D1b0F70418141723d02E56e1',
  votingManager: '0x776A53c2e95d068d269c0cCb1B0081eCfeF900EB',
  treasury: '0xd4d84f3477eb482783aAB48F00e357C801c48928',
  captainHook: '0x38A6C6074f4E14c82dB3bdDe4cADC7Eb2967fa9B',
  clankerCollector: '0xAcFC2aD738599f5E5F0B90B11774b279eb2CF280'
};
```