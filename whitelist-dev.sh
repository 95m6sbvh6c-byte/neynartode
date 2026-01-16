#!/bin/bash
# Whitelist dev wallet on PrizeNFT Season 0 contract

PRIZE_NFT="0x54E3972839A79fB4D1b0F70418141723d02E56e1" # V2
DEV_WALLET="0x78EeAA6F014667A339fCF8b4eCd74743366603fb"
RPC_URL="https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC"

echo "🦎 Whitelisting dev wallet for Season 0..."
echo "Contract: $PRIZE_NFT"
echo "Address: $DEV_WALLET"
echo ""
echo "Please provide your private key (it will not be saved):"
echo "(You won't see your input - this is normal for security. Just paste and press Enter)"
read -s PRIVATE_KEY
echo ""
echo "✓ Private key received, sending transaction..."
echo ""

cast send $PRIZE_NFT \
  "addToWhitelist(address)" \
  $DEV_WALLET \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Successfully whitelisted $DEV_WALLET"
  echo ""
  echo "You can now connect to the app at: https://neynartode.vercel.app/app"
else
  echo ""
  echo "❌ Failed to whitelist. Make sure you're using the contract owner's private key."
fi
