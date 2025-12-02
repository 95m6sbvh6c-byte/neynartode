# NEYNARtodes - Season 0 Beta

> Farcaster Mini App for hosting social contests on Base

NEYNARtodes lets you create contests tied to your Farcaster casts. Reward your community for engagement - likes, recasts, replies, and trading volume. Winners are selected randomly via Chainlink VRF.

**Live App:** [frame-opal-eight.vercel.app/app](https://frame-opal-eight.vercel.app/app)

---

## What is NEYNARtodes?

NEYNARtodes is a gamified social engagement platform built on Farcaster and Base. Host contests, vote on your favorite creators, and earn rewards.

### Core Features

| Feature | Description |
|---------|-------------|
| **Create Contests** | Lock prizes in escrow, set engagement requirements |
| **Chainlink VRF** | Provably fair random winner selection |
| **Vote on Hosts** | Upvote/downvote creators, burn tokens |
| **Season Rewards** | Top hosts win the prize pool |

---

## Quick Start

### For Users

1. Open NEYNARtodes in Warpcast
2. Connect with your Farcaster wallet
3. You need:
   - 20,000+ NEYNARTODES tokens
   - Whitelisted address (Season 0 Beta)

### For Developers

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/neynartodes-frame.git
cd neynartodes-frame/frame

# Install dependencies
npm install

# Run locally
vercel dev

# Deploy
vercel --prod
```

---

## App Pages

### Create Page
Create new contests with custom prizes and requirements.

**Features:**
- Start immediately or schedule for later
- Set duration (hours + minutes)
- Choose any ERC-20 token as prize
- Require likes, recasts, and/or replies
- Optional trading volume requirement

[Full Create Guide](./docs/GUIDE_CREATE.md)

### History Page
View all past and active contests.

**Features:**
- See contest status (Active, Pending VRF, Completed)
- View winners with Farcaster profiles
- Track participant counts
- Monitor prize distributions

[Full History Guide](./docs/GUIDE_HISTORY.md)

### Leaderboard Page
Vote on hosts and track season standings.

**Features:**
- Top 10 hosts ranked by score
- Upvote/downvote with NEYNARTODES
- 10 votes per day
- Season countdown and prize pool

[Full Leaderboard Guide](./docs/GUIDE_LEADERBOARD.md)

---

## How Contests Work

### Creating a Contest

1. **Post on Warpcast** - Create your contest announcement cast
2. **Set Requirements** - Define engagement needed (likes, recasts, replies)
3. **Lock Prize** - Tokens held in escrow contract
4. **Wait for Entries** - Participants engage with your cast
5. **Winner Selected** - Chainlink VRF picks random winner
6. **Prize Distributed** - Automatic transfer to winner

### Entering a Contest

1. **Find a contest** - Check announcements on Warpcast
2. **Engage** - Like, recast, and reply as required
3. **Meet requirements** - Trade volume if needed
4. **Wait** - Winner selected when contest ends
5. **Win** - Prize sent directly to your wallet

---

## Voting System

| Action | Cost | Effect |
|--------|------|--------|
| Upvote | 1000 NEYNARTODES | +5000 points to host |
| Downvote | 1000 NEYNARTODES | -5000 points from host |

**Token Distribution:**
- 50% burned (deflationary)
- 50% to treasury (prize pool)

**Limits:**
- 10 votes per day
- 1 vote per host per day
- Resets at midnight UTC

---

## Season 0 Beta

### Requirements

| Requirement | Value |
|-------------|-------|
| Whitelist | Yes (74 beta testers) |
| Token Gate | 20,000 NEYNARTODES |
| Network | Base Mainnet |

### Safeguards

| Safeguard | Purpose |
|-----------|---------|
| Whitelist | Trusted beta testers only |
| Token Gate | Skin in the game |
| Reply Quality | 4+ words prevents spam |
| Volume Cap | Prevents gaming |

---

## Contract Addresses

| Contract | Address |
|----------|---------|
| **NEYNARTODES Token** | `0x8de1622fe07f56cda2e2273e615a513f1d828b07` |
| **Contest Escrow** | `0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A` |
| **Prize NFT V2** | `0x54E3972839A79fB4D1b0F70418141723d02E56e1` |
| **Voting Manager V2** | `0x267Bd7ae64DA1060153b47d6873a8830dA4236f8` |
| **Treasury V2** | `0xd4d84f3477eb482783aAB48F00e357C801c48928` |

[Full Contract Registry](./docs/CONTRACT_REGISTRY.md)

---

## Technical Architecture

```
Warpcast/Farcaster
       |
       v
  NEYNARtodes Mini App (app.html)
       |
  +----+----+
  |         |
  v         v
Neynar    Alchemy RPC
 API         |
             v
      Base Mainnet Contracts
             |
             v
      Chainlink VRF v2.5
```

[Full System Architecture](./docs/SYSTEM_ARCHITECTURE.md)

---

## Project Structure

```
frame/
├── index.html          # Frame entry point
├── app.html            # Main Mini App (~3700 lines)
├── vercel.json         # Vercel config
├── package.json        # Dependencies
├── docs/
│   ├── CONTRACT_REGISTRY.md
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── GUIDE_CREATE.md
│   ├── GUIDE_HISTORY.md
│   └── GUIDE_LEADERBOARD.md
└── api/
    ├── image.js        # Frame image generator
    ├── leaderboard.js  # Leaderboard API
    ├── finalize.js     # Contest finalization
    └── ...
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Contract Registry](./docs/CONTRACT_REGISTRY.md) | All contract addresses and descriptions |
| [System Architecture](./docs/SYSTEM_ARCHITECTURE.md) | Technical system design |
| [Create Guide](./docs/GUIDE_CREATE.md) | How to create contests |
| [History Guide](./docs/GUIDE_HISTORY.md) | Understanding contest history |
| [Leaderboard Guide](./docs/GUIDE_LEADERBOARD.md) | Voting and rankings |
| [Deployment Guide](./DEPLOYMENT.md) | Deploy your own instance |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS + Tailwind CSS |
| Web3 | ethers.js v5 |
| Social | Neynar API (Farcaster) |
| Blockchain | Base Mainnet |
| Randomness | Chainlink VRF v2.5 |
| Hosting | Vercel |
| Analytics | Vercel Analytics |

---

## FAQ

**Q: How are winners selected?**
A: Chainlink VRF provides a verifiable random number. Winner = qualified entries[random % count].

**Q: Can I cancel a contest?**
A: Yes, before finalization. Prize returns to host.

**Q: What if there are no qualified entries?**
A: Contest cannot finalize. Host can cancel and reclaim prize.

**Q: How long does VRF take?**
A: Usually 1-3 minutes after contest ends.

**Q: Can I host multiple contests?**
A: Yes, but Season 0 may have limits for non-dev wallets.

---

## Support

- **Issues:** GitHub Issues
- **Farcaster:** @neynartodes
- **BaseScan:** Check contract transactions

---

## License

MIT

---

**Built with by the NEYNARtodes team**