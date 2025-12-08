# Create Page Guide

> How to create contests on NEYNARtodes

---

## Overview

The Create page lets you launch contests that reward your Farcaster community for engagement. Winners are selected randomly via Chainlink VRF from participants who meet your requirements.

**Prize Types:**
- **ETH Contests** - Award ERC-20 tokens as prizes
- **NFT Contests** - Award NFTs (ERC-721) as prizes

---

## Before You Start

1. **Post your contest announcement on Farcaster first** - You'll need the cast URL
2. **Have prizes ready:**
   - For ETH contests: ERC-20 tokens in your wallet
   - For NFT contests: An NFT you own
3. **Approve spending** - You'll be prompted to approve before creating

---

## Step-by-Step Guide

### 1. Contest Period

**Start Mode:**
- **Start Now** - Contest begins immediately after creation
- **Schedule** - Set a future start date/time

**Duration:**
- Set hours and minutes for how long the contest runs
- Minimum: 1 minute
- When the timer ends, winner selection begins automatically

---

### 2. Prize Type Selection

First, choose your prize type using the toggle buttons:
- **ETH** - Award ERC-20 tokens
- **NFT** - Award an NFT from your wallet

---

### 2a. ETH Prize Settings

**Search for your prize token:**
1. Type the token name or ticker in the search box
2. Select from the dropdown (shows name, ticker, and market cap)
3. Enter the prize amount

**Supported tokens:**
- Any ERC-20 token on Base
- Popular options: USDC, NEYNARTODES, DEGEN, etc.

**Note:** Prizes are locked in the Contest Escrow contract until the winner is selected. This is trustless - even you can't withdraw once locked.

---

### 2b. NFT Prize Settings

**Two ways to select your NFT:**

**Option 1: My NFTs Button (Recommended)**
1. Click "My NFTs" to open the NFT picker
2. Browse all NFTs in your connected wallet
3. View collection names, images, and floor prices
4. Click on an NFT to select it
5. NFT details auto-populate in the form

**Option 2: Manual Entry**
1. Enter the NFT contract address
2. Enter the Token ID

**Supported NFTs:**
- ERC-721 NFTs on Base
- Displays image preview when selected
- Shows collection name and metadata

**Note:** NFTs are transferred to the NFT Escrow contract and held until the winner is selected.

---

### 3. Social Dynamics (Required)

**Contest Cast URL:**
- Paste the full Farcaster URL: `https://warpcast.com/username/0x1234abcd`
- Or just the hash: `0x1234abcd`

This cast is where participants engage. The system tracks:
- Likes on the cast
- Recasts
- Replies (must be 4+ words to count)

**Engagement Requirements:**
| Setting | Range | Description |
|---------|-------|-------------|
| Min Likes | 0-1 | Require participants to like the cast |
| Min Recasts | 0-1 | Require participants to recast |
| Min Replies | 0+ | Require reply count (4+ words each) |

---

### 4. Trading Volume Requirement (Optional)

**When Enabled (Free):**
- Participants must have traded a minimum USD volume
- Default token: NEYNARTODES
- Can use custom token (e.g., the prize token)
- Volume cap: $10 for NEYNARTODES, or <= prize value for custom

**When Disabled (0.001 ETH fee):**
- No trading requirement
- Small fee helps prevent spam contests

---

## Launch Process

### For ETH Contests:
1. **Review all settings** - Check the summary at bottom
2. **Click "Launch Contest"**
3. **Approve token** - First transaction approves spending
4. **Create contest** - Second transaction creates and locks prize
5. **Wait for confirmation** - Takes ~15-30 seconds on Base

### For NFT Contests:
1. **Review all settings** - Check the summary at bottom
2. **Click "Launch Contest"**
3. **Approve NFT** - First transaction approves the NFT transfer
4. **Create contest** - Second transaction creates contest and transfers NFT to escrow
5. **Wait for confirmation** - Takes ~15-30 seconds on Base

---

## After Launch

**You'll see:**
- Contest ID number
- Escrow confirmation
- Transaction link to BaseScan

**What happens next:**
1. Your contest appears in the History tab
2. Participants engage with your cast
3. When time ends, Chainlink VRF selects a winner
4. Prize automatically transfers to winner
5. Winner announcement cast is posted with the prize details (NFT image included for NFT prizes)

---

## Season 0 Safeguards

During beta, these protections are active:

| Safeguard | Description |
|-----------|-------------|
| Whitelist | Only whitelisted addresses can participate |
| Token Gate | Participants need 20K+ NEYNARTODES |
| Reply Quality | Replies must have 4+ words |
| Volume Cap | Prevents gaming with large fake trades |

---

## Tips for Success

1. **Announce clearly** - Tell people how to enter in your cast
2. **Set fair requirements** - Don't make it too hard to qualify
3. **Reasonable duration** - Give people time to participate
4. **Engage with replies** - Active threads get more visibility
5. **Share the cast** - Cross-post to other channels

---

## Troubleshooting

**"Transaction failed"**
- Check you have enough tokens for the prize
- Check you have ETH for gas
- Try refreshing and reconnecting wallet

**"Cast not found"**
- Make sure you posted the cast publicly
- Use the full URL or correct hash
- Wait a minute for Neynar to index new casts

**"Not enough balance"**
- You need the exact prize amount in your wallet
- Plus a small amount of ETH for gas (~$0.10)

**"NFT not showing in picker"**
- Make sure the NFT is in your connected wallet
- Try refreshing the NFT list
- Some NFTs may take time to appear after minting

**"NFT approval failed"**
- Check you own the NFT
- Ensure you haven't already transferred it
- Try disconnecting and reconnecting wallet