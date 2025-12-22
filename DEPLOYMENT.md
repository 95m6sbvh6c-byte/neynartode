# NEYNARtodes Farcaster Frame App - Complete Documentation

**Last Updated:** December 22, 2025

---

## Overview

NEYNARtodes is a Farcaster Frame v2 (Mini App) that enables users to host and enter token-gated raffles/contests with prizes in ETH, ERC20 tokens, or NFTs. The app runs on Base mainnet and integrates with Farcaster for social engagement verification.

**Live URL:** https://frame-opal-eight.vercel.app

---

## Core Features

### 1. Contest System

Two contest versions are supported:

| Version | Contest IDs | Features |
|---------|-------------|----------|
| **V1 (Legacy)** | 1-104 | Single winner, volume requirements, supports ETH & NFT prizes |
| **V2 (Current)** | 105+ | Multi-winner support, no volume requirements, unified contract |

**Key Difference:** V2 contests only count users who click "Enter Raffle" - passive likes/recasts don't automatically enter users.

### 2. Entry System

**Base Entry:** Every user gets 1 entry

**Bonus Entries (max 3 total):**
| Bonus | Requirement | Extra Entries |
|-------|-------------|---------------|
| Holder Bonus | 100M+ NEYNARTODES | +1 |
| Reply Bonus | Reply with 2+ words | +1 |

**Entry Flow:**
1. **Holders (100M+ tokens):** Click "Enter" → Instant entry (like/recast posted automatically)
2. **Non-holders:** Click "Enter" → Pay ~0.0001 ETH → Burns 1M NEYNARTODES → Entry recorded

### 3. Winner Selection

- Uses Chainlink VRF for provably fair randomness
- V2 supports multiple winners (prize split equally)
- Winners announced automatically via reply to contest cast

### 4. Leaderboard & Voting

**Scoring Formula:**
```
Total Score = Contest Score + Vote Score

Contest Score = (Host Bonus) + (Social × Contests) + (Token Holdings / 50,000)
- Host Bonus: 100 points per completed contest
- Social: (Likes×1 + Recasts×2 + Replies×3) × 100

Vote Score = (Upvotes - Downvotes) × 200
```

**Voting Cost:** 1,000 NEYNARTODES per vote (50% burned, 50% to treasury)

---

## Contract Addresses

### Active Contracts (V2 System)

| Contract | Address | Purpose |
|----------|---------|---------|
| **ContestManager V2** | `0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06` | Unified contest management (ETH, ERC20, NFT) |
| **NEYNARTODES Token** | `0x8dE1622fE07f56cda2e2273e615A513F1d828B07` | Main token |
| **BuyAndBurn_Quoted** | `0x30f71E83030E28FA5916099664cbfAFBb4D07EAC` | Entry fee burns 1M tokens |
| **PrizeNFT_Season0_V2** | `0x54E3972839A79fB4D1b0F70418141723d02E56e1` | Season management, prizes |
| **VotingManager_Season0_V2** | `0x267Bd7ae64DA1060153b47d6873a8830dA4236f8` | Host voting |
| **Treasury_V2** | `0xd4d84f3477eb482783aAB48F00e357C801c48928` | Central treasury |

### V1 Contracts (Legacy - Still Active for Old Contests)

| Contract | Address | Contest IDs |
|----------|---------|-------------|
| **ContestEscrow** | `0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A` | 1-65 (ETH prizes) |
| **NFTContestEscrow** | `0xFD6e84d4396Ecaa144771C65914b2a345305F922` | 66-104 (NFT prizes) |

### Supporting Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| **Uniswap V4 State View** | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | Token pricing |
| **Chainlink ETH/USD** | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | Price oracle |
| **ClankerFeeCollector_V2** | `0xAcFC2aD738599f5E5F0B90B11774b279eb2CF280` | Fee collection |
| **Captain Hook** | `0x38A6C6074f4E14c82dB3bdDe4cADC7Eb2967fa9B` | LP management |

---

## API Endpoints

### Contest Operations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/enter-contest` | POST | Record contest entry |
| `/api/check-eligibility` | GET | Check holder status & requirements |
| `/api/check-entries` | GET | Get entry status for user |
| `/api/contest-participants` | GET | Get participant PFPs & entry counts |
| `/api/contest-history` | GET | Get completed contests |
| `/api/finalize-contest` | POST | Trigger contest finalization |
| `/api/announce-winner` | POST | Post winner announcement |

### Frame Actions

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/frame-action` | POST | Handle "Enter Raffle" button |
| `/api/frame-callback` | POST | Handle transaction callbacks |
| `/api/frame-image` | GET | Generate dynamic contest images |
| `/api/frame` | GET | Frame metadata |

### User & Auth

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/signer-create` | POST | Create Neynar signer |
| `/api/signer-status` | GET | Check signer approval |
| `/api/signer-clear` | DELETE | Remove signer |
| `/api/check-access` | GET | Check wallet eligibility |

### Data & Stats

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/leaderboard` | GET | Get host leaderboard |
| `/api/all-time-prizes` | GET | Get total prizes distributed |
| `/api/get-user-nfts` | GET | Get user's NFT holdings |

### Admin & Maintenance

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/entry-clear` | GET | Clear entry for testing |
| `/api/admin-clear-announced` | POST | Reset announcement flags |
| `/api/cron-daily` | GET | Daily maintenance tasks |
| `/api/cron-notifications` | GET | Process notification queue |

---

## Configuration

### Environment Variables (Vercel)

```
NEYNAR_API_KEY=           # Neynar API key for Farcaster
BASE_RPC_URL=             # Base mainnet RPC (default: https://mainnet.base.org)
KV_REST_API_URL=          # Vercel KV URL
KV_REST_API_TOKEN=        # Vercel KV token
ALCHEMY_API_KEY=          # Alchemy key for NFT metadata
```

### Key Constants (lib/config.js)

```javascript
HOLDER_THRESHOLD: 100000000    // 100M NEYNARTODES for holder status
CUSTOM_TOKEN_THRESHOLD: 200000000  // 200M for custom token contests
V2_START_ID: 105               // Contest IDs >= 105 use V2
MAX_ENTRIES_PER_CONTEST: 1000  // Gas limit safety
BLOCKED_FIDS: [1188162]        // Cannot win (app owner)
```

---

## Contest Flow

### Creating a Contest (V2)

1. Host calls `createContest()` on ContestManager V2
2. Deposits prize (ETH, ERC20, or NFT)
3. Cast ID stored on-chain (format: `castHash|R1L0P1|imageUrl`)
4. Contest goes Active

### Entering a Contest

```
User clicks "Enter Raffle"
        ↓
Check holder status (100M+ NEYNARTODES)
        ↓
┌─────────────────────┬─────────────────────┐
│ Holder (100M+)      │ Non-holder          │
├─────────────────────┼─────────────────────┤
│ Direct entry        │ Buy & burn 1M tokens│
│ Like/recast posted  │ (~0.0001 ETH)       │
│ Entry recorded      │ Then entry recorded │
└─────────────────────┴─────────────────────┘
        ↓
Entry stored in KV: contest_entries:{id}
        ↓
Announcement cast posted (optional)
```

### Finalizing a Contest

```
Contest end time reached
        ↓
Fetch all engagement (likes, recasts, replies)
        ↓
Filter by social requirements (R1L0P1 format)
        ↓
V1: Check trading volume for non-holders
V2: Only count KV-recorded entries
        ↓
Build raffle entries with bonuses:
- 1 base entry per user
- +1 if holder (100M+)
- +1 if replied (2+ words)
        ↓
Call finalizeContest() on contract
        ↓
Chainlink VRF selects winner(s)
        ↓
Prize distributed, announcement posted
```

---

## Display Features

### Participant PFPs

Shows floating profile pictures with color-coded borders:
- **Purple border:** 1 entry (base only)
- **Green border:** 2 entries (base + 1 bonus)
- **Gold border:** 3 entries (base + 2 bonuses)

### Active Contests Section

Displays:
- Prize amount & token/NFT type
- Time remaining
- Entry count
- Winner count (yellow if multiple)
- Participant PFPs

### History Tab

Shows completed contests with:
- Host info
- Prize details
- Winner(s) with usernames
- Entry statistics

---

## Technical Stack

- **Runtime:** Node.js + Vercel Serverless Functions
- **Blockchain:** Ethers.js v6, Base Mainnet
- **Storage:** Vercel KV (Redis)
- **APIs:** Neynar (Farcaster), Alchemy (NFTs), Chainlink (pricing)
- **Frontend:** HTML/Tailwind with Farcaster Frame v2 format

---

## Deployment

### Quick Deploy to Vercel

1. Push to GitHub
2. Import to Vercel
3. Add environment variables
4. Deploy

### Local Development

```bash
cd "/Users/brianwharton/Desktop/Neynartodes /frame"
npm install
vercel dev
# Open http://localhost:3000
```

### Testing Frames

1. Use Warpcast Frame Validator: https://warpcast.com/~/developers/frames
2. Enter frame URL and test all buttons
3. Verify transaction flows work correctly

---

## Maintenance

### Daily Tasks
- Monitor `/api/cron-daily` for errors
- Check VRF subscription balance
- Review finalization queue

### Regular Tasks
- Fund prize pools via `fund-host-pool.ts`
- Claim Clanker fees via `claim-clanker-fees.js`
- Compound LP via `compound-hook.ts`

### Troubleshooting

**Entry not recording:**
- Check KV connection
- Verify signer is approved
- Check holder balance calculation

**Winner not announced:**
- Check `announced_contests` KV key
- Verify Neynar API key
- Run `announce-winner` manually

**Frame not loading:**
- Validate meta tags at warpcast.com/~/developers/frames
- Check API endpoint responses
- Review Vercel function logs

---

## Season System

The app supports unlimited seasons via PrizeNFT_Season0_V2:

- **Season 1:** Beta (30 days, whitelist enabled)
- **Season 2+:** Public seasons with host/voter prize pools

To end beta: Call `endSeason0()` on contract

---

## Links

- **Frame Docs:** https://docs.farcaster.xyz/reference/frames/spec
- **Neynar API:** https://docs.neynar.com/
- **Base Block Explorer:** https://basescan.org
- **Chainlink VRF:** https://vrf.chain.link/

---

**Questions?** Check the CONTRACT-REGISTRY.md in the contracts repo for complete contract details.
