# NEYNARtodes System Architecture

> Last Updated: December 8, 2025

## Overview

NEYNARtodes is a Farcaster Mini App for hosting social contests on Base. Users create contests tied to Farcaster casts, and winners are selected via Chainlink VRF based on social engagement and trading volume requirements.

---

## System Components

```
+---------------------------+
|    Farcaster Client       |
|    (Warpcast, etc.)       |
+------------+--------------+
             |
             v
+---------------------------+
|   NEYNARtodes Mini App    |
|   (app.html - Frontend)   |
+------------+--------------+
             |
     +-------+-------+-------+
     |               |       |
     v               v       v
+----------+   +-----------+   +------------+
| Neynar   |   | Alchemy   |   | Vercel KV  |
| API      |   | RPC + NFT |   | (Storage)  |
| (Social) |   | (Chain)   |   |            |
+----------+   +-----------+   +------------+
                    |
                    v
+---------------------------+
|   Base Mainnet Contracts  |
|   - Contest Escrow (ETH)  |
|   - NFT Escrow            |
|   - Voting Manager        |
|   - Prize NFT             |
|   - Treasury              |
+---------------------------+
             |
             v
+---------------------------+
|   Chainlink VRF v2.5      |
|   (Random Winner Select)  |
+---------------------------+
```

---

## Core Flows

### 1a. ETH Contest Creation Flow

```
Host                    Frontend                Escrow Contract         VRF
 |                         |                          |                  |
 |--Create Contest-------->|                          |                  |
 |                         |--Approve Token---------->|                  |
 |                         |--createContestERC20()--->|                  |
 |                         |                          |--Lock Prize----->|
 |                         |<--Contest ID-------------|                  |
 |<--Success---------------|                          |                  |
```

### 1b. NFT Contest Creation Flow

```
Host                    Frontend               NFT Escrow Contract      VRF
 |                         |                          |                  |
 |--Create NFT Contest---->|                          |                  |
 |                         |--Approve NFT------------>|                  |
 |                         |--createContestNFT()----->|                  |
 |                         |                          |--Transfer NFT--->|
 |                         |<--Contest ID-------------|                  |
 |<--Success---------------|                          |                  |
```

### 2. Winner Selection Flow

```
Backend                 Escrow Contract              Chainlink VRF
 |                            |                           |
 |--finalizeContest()-------->|                           |
 |  (qualified addresses)     |--requestRandomWords()---->|
 |                            |                           |
 |                            |<--fulfillRandomWords()----|
 |                            |--Select Winner----------->|
 |                            |--Transfer Prize---------->|
 |<--ContestCompleted---------|                           |
```

### 3. Voting Flow

```
Voter                   Frontend              Voting Contract        Treasury
 |                         |                        |                   |
 |--Cast Vote------------->|                        |                   |
 |                         |--vote(hostFid, up)---->|                   |
 |                         |                        |--Burn 500-------->|
 |                         |                        |--Send 500-------->|
 |                         |<--Vote Recorded--------|                   |
 |<--Success---------------|                        |                   |
```

---

## Data Architecture

### State Management (Frontend)

```javascript
const state = {
  // Authentication
  isLoggedIn: boolean,
  isWhitelisted: boolean,
  hasTokens: boolean,
  userAddress: string,
  userFid: number,
  userBalance: string,

  // Views
  currentView: 'create' | 'history' | 'leaderboard',

  // Contest Creation
  prizeType: 'eth' | 'nft',           // NEW: Prize type selection
  startMode: 'now' | 'scheduled',
  durationHours: number,
  durationMinutes: number,
  prizeTokenAddress: string,
  prizeTokenAmount: number,
  nftContractAddress: string,         // NEW: NFT contract
  nftTokenId: string,                 // NEW: NFT token ID
  selectedNft: Object | null,         // NEW: Selected NFT from picker
  castHash: string,
  tokenomicsEnabled: boolean,

  // NFT Picker                        // NEW SECTION
  showNftPicker: boolean,
  userNfts: NFT[],
  nftLoading: boolean,
  nftPageKey: string | null,

  // Leaderboard
  leaderboardData: Host[],
  votesRemaining: number,
  totalTokensBurned: number,

  // History
  historyData: Contest[],
  historyTotal: number,

  // Season
  currentSeason: number,
  seasonEnd: Date,
  hostPoolETH: number
};
```

### Contest Data Structure (On-Chain)

```solidity
struct Contest {
    address host;
    address prizeToken;
    uint256 prizeAmount;
    uint256 startTime;
    uint256 endTime;
    string castId;
    address tokenRequirement;
    uint256 volumeRequirement;
    ContestStatus status;  // Active, PendingVRF, Completed, Cancelled
    address winner;
    address[] qualifiedEntries;
}
```

---

## API Integrations

### Neynar API (Farcaster Data)

| Endpoint | Purpose |
|----------|---------|
| `/v2/farcaster/user/bulk` | Fetch user profiles by FID |
| `/v2/farcaster/cast` | Get cast details and engagement |
| `/v2/farcaster/cast/conversation` | Get replies to a cast |
| `/v2/farcaster/cast` (POST) | Post winner announcement casts |

### Alchemy API (Blockchain + NFT Data)

| Method | Purpose |
|--------|---------|
| `eth_call` | Read contract state |
| `eth_sendTransaction` | Submit transactions |
| `eth_getTransactionReceipt` | Confirm transactions |
| `getNFTsForOwner` | Fetch user's NFTs for picker |

### Uniswap Subgraph

| Query | Purpose |
|-------|---------|
| `swaps` | Calculate trading volume |
| `token` | Get token metadata |

### Vercel KV (Storage)

| Key Pattern | Purpose |
|-------------|---------|
| `contest_message_{id}` | Contest custom messages |
| `contest_price_{id}` | Captured token prices at contest creation |

---

## Security Model

### Season 0 Safeguards

| Safeguard | Description |
|-----------|-------------|
| **Whitelist** | Only whitelisted addresses can participate |
| **Token Gate** | Minimum 20,000 NEYNARTODES required |
| **Reply Quality** | Minimum 4 words per reply |
| **Volume Cap** | $10 max for NEYNARTODES, or <= prize value |

### Contract Security

| Feature | Implementation |
|---------|----------------|
| **Prize Custody** | Escrow holds prizes until VRF completion |
| **Randomness** | Chainlink VRF v2.5 (tamper-proof) |
| **Access Control** | Owner-only admin functions |
| **Reentrancy** | Protected via checks-effects-interactions |

---

## Token Economics

### Voting Burn Mechanics

```
1 Vote = 1000 $NEYNARTODES
         |
    +----+----+
    |         |
   500       500
  BURNED   TREASURY
    |         |
    v         v
  Supply   Prize Pool
 Reduction   Growth
```

### Contest Fee Structure

| Scenario | Fee |
|----------|-----|
| With Tokenomics | Free (volume requirement enabled) |
| Without Tokenomics | 0.001 ETH |
| Dev Wallet | Always free |

---

## Deployment Architecture

```
GitHub Repo
     |
     v
+----------+
|  Vercel  |
+----+-----+
     |
     +---> /           (index.html - Frame entry)
     +---> /app        (app.html - Mini App)
     +---> /api/*      (Serverless functions - 11 total)
```

### Serverless Functions (API)

| Endpoint | Purpose |
|----------|---------|
| `/api/announce-winner` | Post winner announcement casts |
| `/api/check-access` | Verify whitelist + token gate |
| `/api/check-eligibility` | Validate participant requirements |
| `/api/connect` | Wallet connection |
| `/api/contest-history` | Fetch contest data |
| `/api/contest-participants` | Get participant PFPs for active contests |
| `/api/enter-contest` | Record contest entry + auto like/recast |
| `/api/finalize-contest` | Contest finalization + VRF (V1 + V2) |
| `/api/get-user-nfts` | NFT picker (Alchemy API) |
| `/api/image` | Frame OG image generator |
| `/api/leaderboard` | Leaderboard rankings |
| `/api/post-cast` | Post cast on behalf of user via signer |
| `/api/signer-create` | Create Neynar managed signer for user |
| `/api/signer-status` | Check signer approval status |
| `/api/store?type=message` | Contest message storage |
| `/api/store?type=price` | Token price capture |

### Shared Libraries (api/lib/)

| File | Purpose |
|------|---------|
| `config.js` | Shared RPC URLs, contract addresses |
| `utils.js` | Helper functions (formatting, validation) |
| `uniswap-volume.js` | Trading volume calculations |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEYNAR_API_KEY` | Farcaster API access |
| `BASE_RPC_URL` | Alchemy RPC (includes API key) |
| `KV_REST_API_URL` | Vercel KV storage |
| `KV_REST_API_TOKEN` | Vercel KV auth |
| `PRIVATE_KEY` | Transaction signing |

---

## Frontend Architecture

### Single-Page App Structure

```
app.html
├── <head>
│   ├── Farcaster Mini App meta tags
│   ├── Ethers.js v6 (CDN)
│   ├── Tailwind CSS (CDN)
│   ├── Farcaster SDK (ESM)
│   └── Vercel Analytics
├── <body>
│   ├── Toast container
│   ├── NFT Picker modal
│   └── #app (React-like render target)
└── <script>
    ├── CONFIG (contracts, API keys)
    ├── STATE (reactive state object)
    ├── API Functions (Neynar, RPC, Alchemy NFT)
    ├── Contract Interactions
    ├── NFT Picker Functions
    │   ├── loadUserNfts()
    │   ├── renderNftPicker()
    │   └── selectNft()
    ├── Render Functions
    │   ├── renderLoginPage()
    │   ├── renderCreateContest()
    │   ├── renderHistory()
    │   └── renderLeaderboard()
    └── Event Handlers
```

### Navigation

| Tab | View | Description |
|-----|------|-------------|
| Create | `renderCreateContest()` | Contest creation form |
| History | `renderHistory()` | Past contests table |
| Leaderboard | `renderLeaderboard()` | Host rankings + voting |

---

## Farcaster SDK Integration

The app uses the Farcaster Mini App SDK for native integration with Warpcast.

### SDK Initialization

```javascript
import sdk from '@farcaster/frame-sdk';
await sdk.actions.ready(); // Signal app is ready
const context = await sdk.context; // Get user context (FID, username, etc.)
```

### SDK Actions Used

| Action | Purpose | Usage |
|--------|---------|-------|
| `sdk.actions.ready()` | Signal app is loaded and ready | Called on startup |
| `sdk.context` | Get user's Farcaster context (FID, profile, etc.) | Authentication |
| `sdk.actions.composeCast({ text, embeds })` | Open compose modal with pre-filled text | Contest announcements, sharing |
| `sdk.actions.swapToken({ buyToken })` | Open token swap interface | Buy $NEYNARTODES |
| `sdk.actions.addFrame()` | Request notification permissions | Enable push notifications |
| `sdk.wallet.ethProvider` | Get Ethereum provider for transactions | Contest creation, voting |

### Neynar Managed Signers

For actions that require posting casts on behalf of users (auto like/recast on entry):

```
User App Flow:
1. User connects → /api/signer-create creates managed signer
2. User approves in Warpcast (QR code or deep link)
3. /api/signer-status polls for approval
4. Approved signer_uuid stored in KV (signer:{fid})
5. Future actions use signer to post casts via Neynar API
```

### Posting Casts via Signer

```javascript
// POST /api/post-cast
{
  fid: 12345,
  text: "Cast content...",
  quoteCastHash: "0x...",  // Optional: quote a cast
  embedUrls: ["https://..."],  // Optional: image/link embeds
  replyTo: "0x..."  // Optional: reply to a cast
}
```

---

## Future Architecture (Planned)

### Multi-Winner Support

See [MULTI_WINNER_IMPLEMENTATION.md](./MULTI_WINNER_IMPLEMENTATION.md) for planned changes:
- Contract struct changes for `address[] winners`
- VRF multi-word requests
- Prize splitting logic

### Season 1+ Scaling

- Remove whitelist requirement
- Lower token gate
- Add more contest types
- Cross-chain support