# 🐸 NEYNARtodes Farcaster Frame - Season 0 Beta

A Farcaster Frame that allows users to check their Season 0 Beta eligibility and access the full NEYNARtodes platform.

## ✨ Features

- 🔍 **Check Access** - Verify token balance & whitelist status
- 🎮 **Launch App** - Direct link to full interactive platform
- 📊 **Display Contracts** - Show all Season 0 contract addresses
- ✅ **Farcaster Integration** - Works in Warpcast and all Farcaster clients

## 🎯 Season 0 Requirements

- **Token Gate**: 20,000 NEYNARTODES minimum
- **Whitelist**: 74 beta testers
- **Network**: Base Mainnet
- **Wallet**: Verified Farcaster wallet required

## 📦 Contract Addresses

| Contract | Address |
|----------|---------|
| **PrizeNFT Season 0** | `0x82f5A8CEffce9419886Bb0644FA5D3FB8295Ab81` |
| **VotingManager Season 0 V2** | `0x267Bd7ae64DA1060153b47d6873a8830dA4236f8` |
| **Treasury V2** | `0xd4d84f3477eb482783aAB48F00e357C801c48928` |
| **Captain Hook V2** | `0x38A6C6074f4E14c82dB3bdDe4cADC7Eb2967fa9B` |
| **Clanker Collector V2** | `0xAcFC2aD738599f5E5F0B90B11774b279eb2CF280` |
| **NEYNARTODES Token** | `0x8de1622fe07f56cda2e2273e615a513f1d828b07` |

## 🚀 Quick Start

### 1. Deploy to Vercel

```bash
# Clone and navigate to frame directory
cd frame/

# Install Vercel CLI
npm install -g vercel

# Deploy
vercel --prod
```

### 2. Update Domain URLs

Replace `YOUR_DOMAIN` with your Vercel URL in:
- `index.html`
- `api/check-access.js`
- `api/connect.js`

### 3. Test in Warpcast

Go to: https://warpcast.com/~/developers/frames

Enter your Frame URL and click "Validate"

## 📁 Project Structure

```
frame/
├── index.html              # Main Frame entry point
├── app.html                # Full web app
├── package.json            # Dependencies
├── vercel.json             # Vercel configuration
├── DEPLOYMENT.md           # Detailed deployment guide
├── README.md               # This file
└── api/
    ├── image.js            # Frame image generator
    ├── connect.js          # Connect wallet handler
    └── check-access.js     # Access verification
```

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Run local dev server
vercel dev

# Open browser
open http://localhost:3000
```

## 📖 Full Documentation

See [DEPLOYMENT.md](./DEPLOYMENT.md) for:
- Step-by-step deployment guide
- Customization options
- Debugging tips
- Frame flow diagrams
- Best practices

## 🎮 How It Works

1. **User sees Frame** in Farcaster client
2. **Clicks "Check Access"** button
3. **Frame fetches** user's verified wallet from Farcaster
4. **Checks balance** on Base mainnet (NEYNARTODES token)
5. **Checks whitelist** in PrizeNFT_Season0 contract
6. **Shows result** - ✅ Access Granted or 🚫 Access Denied
7. **User clicks "Launch App"** to open full platform

## 🔑 Environment Variables

Set in Vercel dashboard or `vercel.json`:

- `NEYNAR_API_KEY` - Your Neynar API key (already set in vercel.json)

## 🎨 Customization

### Change Token Gate

Update in `app.html` and `api/check-access.js`:
```javascript
const required = ethers.parseEther('20000'); // Change 20000 to your amount
```

### Update Contracts

Update in `app.html` and `api/check-access.js`:
```javascript
const CONTRACTS = {
  prizeNFT: '0x...', // Your contract address
  // ...
};
```

### Customize Images

Edit SVG generation in:
- `api/image.js` - Initial Frame image
- `api/connect.js` - Connect confirmation
- `api/check-access.js` - Access result

## 🧪 Testing

### Warpcast Frame Validator
https://warpcast.com/~/developers/frames

### Manual Testing
1. Deploy to Vercel
2. Post Frame URL in Warpcast
3. Click buttons to test flow
4. Check Vercel logs for errors

## 📊 Tech Stack

- **Frontend**: React (via CDN in app.html)
- **Styling**: Tailwind CSS
- **Web3**: ethers.js v6
- **API**: Vercel Serverless Functions
- **Farcaster**: Neynar API
- **Blockchain**: Base Mainnet

## 🔗 Links

- **Farcaster Frame Spec**: https://docs.farcaster.xyz/reference/frames/spec
- **Vercel Docs**: https://vercel.com/docs
- **Neynar API**: https://docs.neynar.com/
- **Base Network**: https://base.org

## 📝 License

MIT

## 🎉 Ready to Deploy?

1. Read [DEPLOYMENT.md](./DEPLOYMENT.md)
2. Deploy to Vercel
3. Test in Warpcast
4. Share with your community!

**Let's go! 🚀**
