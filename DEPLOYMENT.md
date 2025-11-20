# 🚀 NEYNARtodes Farcaster Frame - Deployment Guide

## 📋 Overview

This Frame allows Farcaster users to check their Season 0 Beta access directly in Warpcast or other Farcaster clients.

**Features:**
- ✅ Check wallet balance & whitelist status
- ✅ Display Season 0 contract addresses
- ✅ Direct link to full web app
- ✅ Works in all Farcaster clients (Warpcast, etc.)

---

## 🎯 Quick Deployment (Vercel - Recommended)

### Prerequisites
- [Vercel account](https://vercel.com) (free tier works!)
- [GitHub account](https://github.com)
- Node.js installed (optional, for local testing)

### Step 1: Push to GitHub

```bash
cd "/Users/brianwharton/Desktop/Neynartodes /frame"

# Initialize git repo
git init
git add .
git commit -m "Initial NEYNARtodes Frame deployment"

# Create GitHub repo and push
# (Create repo at github.com/new first, then:)
git remote add origin https://github.com/YOUR_USERNAME/neynartodes-frame.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Click **"New Project"**
3. Import your GitHub repo: `neynartodes-frame`
4. Vercel will auto-detect settings (no changes needed!)
5. Click **"Deploy"**
6. Wait ~2 minutes for deployment ⏳

### Step 3: Get Your Frame URL

After deployment completes:
- Vercel will give you a URL like: `https://neynartodes-frame.vercel.app`
- **This is your Frame URL!** 🎉

### Step 4: Update API Routes with Your Domain

Replace `YOUR_DOMAIN` in these files with your actual Vercel URL:

**Files to update:**
- [index.html](./index.html) - Lines 11, 13, 16, 19
- [api/check-access.js](./api/check-access.js) - Line 95, 99
- [api/connect.js](./api/connect.js) - Line 21, 24

**Example:**
```html
<!-- Before -->
<meta property="fc:frame:button:3:target" content="https://YOUR_DOMAIN/app" />

<!-- After -->
<meta property="fc:frame:button:3:target" content="https://neynartodes-frame.vercel.app/app" />
```

**Quick find & replace:**
```bash
# In frame/ directory
sed -i '' 's/YOUR_DOMAIN/neynartodes-frame.vercel.app/g' index.html
sed -i '' 's/YOUR_DOMAIN/neynartodes-frame.vercel.app/g' api/check-access.js
sed -i '' 's/YOUR_DOMAIN/neynartodes-frame.vercel.app/g' api/connect.js

# Commit and push
git add .
git commit -m "Update domain URLs"
git push
```

Vercel will auto-redeploy in ~1 minute!

---

## 📱 Testing Your Frame

### Option 1: Warpcast Frame Validator (Easiest)

1. Go to: https://warpcast.com/~/developers/frames
2. Enter your Frame URL: `https://neynartodes-frame.vercel.app`
3. Click **"Validate"**
4. You'll see a preview with all buttons working! ✅

### Option 2: Post in Warpcast

1. Create a new cast in Warpcast
2. Paste your Frame URL: `https://neynartodes-frame.vercel.app`
3. Warpcast will auto-detect it as a Frame
4. Post it (or save as draft to test privately)
5. Click the buttons to test! 🎮

### Option 3: Local Testing (Development)

```bash
cd "/Users/brianwharton/Desktop/Neynartodes /frame"

# Install dependencies
npm install

# Install Vercel CLI
npm install -g vercel

# Run local dev server
vercel dev

# Open: http://localhost:3000
```

---

## 🎨 Frame Flow

### User Journey:

1. **Initial Frame** (`/` - index.html)
   - Shows Season 0 info image
   - Buttons: "Connect Wallet", "Check Access", "Launch App"

2. **Click "Connect Wallet"** → `/api/connect`
   - Shows user's Farcaster ID
   - Buttons: "Check My Access", "Launch App"

3. **Click "Check Access"** → `/api/check-access`
   - Fetches user's verified wallet from Farcaster
   - Checks NEYNARTODES balance on Base
   - Checks whitelist status
   - Shows ✅ or 🚫 based on eligibility
   - Buttons: "Check Again", "Launch App"

4. **Click "Launch App"** → `/app`
   - Opens full interactive web app
   - User connects MetaMask
   - Full Season 0 interface

---

## 🛠️ File Structure

```
frame/
├── index.html              # Main Frame entry point
├── app.html                # Full web app
├── package.json            # Dependencies
├── vercel.json             # Vercel config
├── .gitignore              # Git ignore file
├── DEPLOYMENT.md           # This file!
└── api/
    ├── image.js            # Generates Frame images (SVG)
    ├── connect.js          # Handles "Connect" button
    └── check-access.js     # Checks token balance & whitelist
```

---

## 🔧 Customization

### Update Contract Addresses

If you deploy new Season 0 contracts, update in:
- **[app.html](./app.html)** - Lines 35-46 (CONTRACTS object)
- **[api/check-access.js](./api/check-access.js)** - Lines 5-9 (CONTRACTS object)

### Change Token Gate

Current: 20K NEYNARTODES

To change, update in:
- **[app.html](./app.html)** - Line 114: `const required = ethers.parseEther('20000');`
- **[api/check-access.js](./api/check-access.js)** - Line 60: `const hasTokens = balanceNum >= 20000;`

### Customize Frame Images

Edit the SVG generation in:
- **[api/image.js](./api/image.js)** - Initial Frame image
- **[api/connect.js](./api/connect.js)** - Connect confirmation image
- **[api/check-access.js](./api/check-access.js)** - Access result image

You can also replace with static PNG files:
```javascript
// Instead of generating SVG, return a URL:
<meta property="fc:frame:image" content="https://your-cdn.com/static-image.png" />
```

---

## 🎯 Sharing Your Frame

### In Warpcast/Farcaster:
Just paste the URL: `https://neynartodes-frame.vercel.app`

### Custom Short Link (Optional):
1. Go to [bit.ly](https://bit.ly) or similar
2. Shorten: `https://neynartodes-frame.vercel.app`
3. Get: `https://bit.ly/neynartodes-s0`
4. Share the short link!

### Add to Your Website:
```html
<a href="https://neynartodes-frame.vercel.app">
  Check Season 0 Access
</a>
```

---

## 🔍 Debugging

### Frame Not Showing?

1. **Check Vercel deployment logs:**
   - Go to vercel.com → Your Project → Deployments
   - Click latest deployment → View Function Logs

2. **Validate Frame meta tags:**
   - Use: https://warpcast.com/~/developers/frames
   - Check all `fc:frame` meta tags are correct

3. **Check API routes:**
   - Test directly: `https://YOUR_DOMAIN/api/image`
   - Should return an SVG or PNG image

### "Check Access" Not Working?

1. **Verify Neynar API key:**
   - Test: `curl -H "api_key: YOUR_KEY" https://api.neynar.com/v2/farcaster/user/bulk?fids=1`
   - Should return user data

2. **Check Base RPC:**
   - Test contract call manually in browser console
   - Verify contract addresses are correct

3. **Check user has verified wallet:**
   - User must verify their wallet in Farcaster settings
   - Otherwise can't fetch their address

---

## 📊 Season 0 Beta Stats

| Metric | Value |
|--------|-------|
| **Whitelisted Users** | 74 beta testers |
| **Token Gate** | 20,000 NEYNARTODES |
| **Network** | Base Mainnet |
| **Contracts** | Season 0 (PrizeNFT + VotingManager) |

### Contract Addresses:
- **PrizeNFT Season 0**: `0x82f5A8CEffce9419886Bb0644FA5D3FB8295Ab81`
- **VotingManager Season 0**: `0xFF730AB8FaBfc432c513C57bE8ce377ac77eEc99`
- **Captain Hook V2**: `0x38A6C6074f4E14c82dB3bdDe4cADC7Eb2967fa9B`
- **Clanker Collector V2**: `0xAcFC2aD738599f5E5F0B90B11774b279eb2CF280`

---

## 🚀 Going Live

### Pre-Launch Checklist:

- ✅ All contract addresses updated
- ✅ Token gate set to 20K
- ✅ Whitelist has 74 users
- ✅ Frame tested in Warpcast validator
- ✅ All buttons work correctly
- ✅ "Launch App" opens full interface
- ✅ Domain URLs replaced (no "YOUR_DOMAIN")

### Launch Steps:

1. **Test thoroughly** in Warpcast Frame Validator
2. **Create announcement cast** with Frame URL
3. **Share in your channels** (Discord, Twitter, etc.)
4. **Monitor Vercel logs** for any errors
5. **Gather feedback** from beta testers
6. **Iterate and improve!** 🎉

---

## 💡 Tips & Best Practices

1. **Keep Frame images simple** - Load fast on mobile
2. **Clear call-to-actions** - Users should know what each button does
3. **Test on multiple devices** - Desktop, mobile, different browsers
4. **Monitor API usage** - Neynar has rate limits (check your plan)
5. **Version your Frame** - Can have `/v1`, `/v2` for testing

---

## 🆘 Support

**Farcaster Frame Docs:**
- https://docs.farcaster.xyz/reference/frames/spec

**Vercel Docs:**
- https://vercel.com/docs

**Neynar API Docs:**
- https://docs.neynar.com/

**Questions?**
- Check Vercel deployment logs
- Test API routes individually
- Use Warpcast Frame Validator
- Review Farcaster Frame spec

---

## 🎉 You're Ready!

Your NEYNARtodes Frame is ready to deploy! Follow the steps above and you'll have a live Farcaster Frame in minutes. 🐸

**Next Steps:**
1. Deploy to Vercel (Step 1-3 above)
2. Update domain URLs (Step 4)
3. Test in Warpcast validator
4. Share with your community!

Good luck with Season 0 Beta! 🚀
