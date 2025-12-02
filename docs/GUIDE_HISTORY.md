# History Page Guide

> View past and active contests on NEYNARtodes

---

## Overview

The History page shows all contests on NEYNARtodes - active, pending, and completed. Track contest progress, see winners, and monitor the platform activity.

---

## Stats Summary

At the top, you'll see four stat cards:

| Card | Description |
|------|-------------|
| **Total Contests** | All-time contest count |
| **Completed** | Contests with winners selected |
| **Active** | Currently running contests |
| **Pending VRF** | Contests waiting for random winner selection |

---

## Contest Table

Each row shows a contest with these columns:

### # (Contest ID)
- Unique identifier for the contest
- Sequential numbering from contract

### Host
- Profile picture and username of contest creator
- Click to visit their Warpcast profile
- Wallet address shown below username

### Prize
- Token amount and symbol (e.g., "1000 $NEYNARTODES")
- Volume requirement shown below if enabled

### Duration
- How long the contest ran/runs
- Format: "Xh Ym" (e.g., "2h 30m")

### Participants
- Number of qualified entries
- These are wallets that met all requirements

### Status
| Status | Meaning |
|--------|---------|
| **Active** | Contest is currently running |
| **Pending VRF** | Contest ended, waiting for Chainlink VRF |
| **Completed** | Winner selected and paid |
| **Cancelled** | Contest was cancelled, prize refunded |

### Winner
- Profile picture and username of winner
- Trophy icon indicates winner
- Click to visit their Warpcast profile
- Shows wallet address below

### Ended
- When the contest ended (or ends)
- Relative time (e.g., "2 hours ago")

---

## Contest Lifecycle

```
1. ACTIVE
   Contest is running, participants can engage

        ↓ (Timer ends)

2. PENDING VRF
   Chainlink VRF generating random number
   Usually takes 1-3 minutes

        ↓ (VRF fulfills)

3. COMPLETED
   Winner selected, prize transferred
   Shows winner profile
```

---

## Auto-Refresh

When viewing the History page:
- Data refreshes automatically every 30 seconds
- Manual refresh available via "Refresh" button
- Real-time updates for active contests

---

## Understanding Participants

The participant count shows **qualified entries**, meaning wallets that:
- Met social requirements (likes, recasts, replies)
- Met volume requirements (if enabled)
- Are whitelisted (Season 0)
- Hold minimum tokens (20K+ NEYNARTODES)

**Note:** One person = one entry. The system deduplicates by wallet address.

---

## Winner Selection

Winners are selected using **Chainlink VRF v2.5**:

1. Contest ends
2. Backend submits qualified addresses to contract
3. Contract requests random number from Chainlink
4. Chainlink provides verifiable random number
5. Winner index = random number % participant count
6. Prize automatically transfers to winner

This is **provably fair** - no one can predict or manipulate the winner.

---

## Viewing Details

**Click on host/winner profiles** to:
- Visit their Warpcast profile
- See their other casts
- Follow them

**Transaction links** (on completion):
- View the prize transfer on BaseScan
- Verify the exact amount sent

---

## Tips

1. **Check status regularly** - Watch your contests progress
2. **Share results** - Winners make great content
3. **Learn from others** - See what prize amounts and durations work
4. **Monitor VRF timing** - Usually 1-3 minutes, sometimes longer

---

## Troubleshooting

**"Loading Contests..."**
- Initial load fetches on-chain data
- May take a few seconds on slow connections

**"Error Loading History"**
- Check your internet connection
- Try the Refresh button
- RPC might be temporarily slow

**Contest stuck in "Pending VRF"**
- VRF usually completes in 1-3 minutes
- If longer, Chainlink may be congested
- Contact support if stuck for 30+ minutes

**Wrong participant count**
- Count updates when contest finalizes
- During active contest, count is estimated