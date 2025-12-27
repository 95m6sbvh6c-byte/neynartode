# Whitelist Your Dev Wallet

Your dev wallet `0x78EeAA6F014667A339fCF8b4eCd74743366603fb` needs to be whitelisted in the PrizeNFT contract.

## Method 1: Using the Script (Easiest)

```bash
cd "/Users/brianwharton/Desktop/Neynartodes /frame"
./whitelist-dev.sh
```

Enter your **contract owner's private key** when prompted.

## Method 2: Manual Cast Command

```bash
cast send 0x54E3972839A79fB4D1b0F70418141723d02E56e1 \
  "addToWhitelist(address)" \
  0x78EeAA6F014667A339fCF8b4eCd74743366603fb \
  --rpc-url https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/ \
  --private-key YOUR_OWNER_PRIVATE_KEY
```

Replace `YOUR_OWNER_PRIVATE_KEY` with the private key of the wallet that deployed/owns the PrizeNFT contract.

## Method 3: Using Environment Variable

```bash
export PRIVATE_KEY="your_owner_private_key_here"

cast send 0x54E3972839A79fB4D1b0F70418141723d02E56e1 \
  "addToWhitelist(address)" \
  0x78EeAA6F014667A339fCF8b4eCd74743366603fb \
  --rpc-url https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/ \
  --private-key $PRIVATE_KEY
```

## After Whitelisting

1. Wait for transaction confirmation (check BaseScan)
2. Visit https://neynartode.vercel.app/app
3. Click "Connect Wallet"
4. You should now have full access!

## Contract Info

- **PrizeNFT Address**: `0x54E3972839A79fB4D1b0F70418141723d02E56e1` (V2)
- **Network**: Base Mainnet (Chain ID: 8453)
- **Function**: `addToWhitelist(address)`
- **Your Dev Wallet**: `0x78EeAA6F014667A339fCF8b4eCd74743366603fb`

## Verify Whitelist Status

After the transaction confirms, you can verify with:

```bash
cast call 0x54E3972839A79fB4D1b0F70418141723d02E56e1 \
  "whitelisted(address)(bool)" \
  0x78EeAA6F014667A339fCF8b4eCd74743366603fb \
  --rpc-url https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/
```

Should return `true` (or `0x0000000000000000000000000000000000000000000000000000000000000001`)
