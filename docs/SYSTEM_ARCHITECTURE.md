# NEYNARtodes System Architecture

> Last Updated: December 2, 2025

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
     +-------+-------+
     |               |
     v               v
+----------+   +-----------+
| Neynar   |   | Alchemy   |
| API      |   | RPC       |
| (Social) |   | (Chain)   |
+----------+   +-----------+
                    |
                    v
+---------------------------+
|   Base Mainnet Contracts  |
|   - Contest Escrow        |
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

### 1. Contest Creation Flow

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
  startMode: 'now' | 'scheduled',
  durationHours: number,
  durationMinutes: number,
  prizeTokenAddress: string,
  prizeTokenAmount: number,
  castHash: string,
  tokenomicsEnabled: boolean,

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

### Alchemy RPC (Blockchain Data)

| Method | Purpose |
|--------|---------|
| `eth_call` | Read contract state |
| `eth_sendTransaction` | Submit transactions |
| `eth_getTransactionReceipt` | Confirm transactions |

### Uniswap Subgraph

| Query | Purpose |
|-------|---------|
| `swaps` | Calculate trading volume |
| `token` | Get token metadata |

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
     +---> /api/*      (Serverless functions)
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEYNAR_API_KEY` | Farcaster API access |
| `ALCHEMY_API_KEY` | RPC access (in code) |

---

## Frontend Architecture

### Single-Page App Structure

```
app.html
├── <head>
│   ├── Farcaster Mini App meta tags
│   ├── Ethers.js v5 (CDN)
│   ├── Tailwind CSS (CDN)
│   ├── Farcaster SDK (ESM)
│   └── Vercel Analytics
├── <body>
│   ├── Toast container
│   └── #app (React-like render target)
└── <script>
    ├── CONFIG (contracts, API keys)
    ├── STATE (reactive state object)
    ├── API Functions (Neynar, RPC)
    ├── Contract Interactions
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