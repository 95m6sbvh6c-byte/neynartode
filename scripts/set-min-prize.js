/**
 * Set Minimum Prize Value for ContestManager
 *
 * Usage: PRIVATE_KEY=0x... node scripts/set-min-prize.js
 *
 * Sets min prize to 0.00015 ETH (~$0.50)
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',
  BASE_RPC: 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  // New minimum: 0.00015 ETH (~$0.50)
  NEW_MIN_ETH: '0.00015',
};

const CONTEST_MANAGER_ABI = [
  'function minPrizeValueWei() view returns (uint256)',
  'function setMinPrizeValue(uint256 _minPrizeValueWei) external',
  'function owner() view returns (address)',
];

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.error('ERROR: PRIVATE_KEY environment variable required');
    console.log('\nUsage: PRIVATE_KEY=0x... node scripts/set-min-prize.js');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('=== Set Minimum Prize Value ===');
  console.log('Wallet:', wallet.address);
  console.log('');

  const contract = new ethers.Contract(CONFIG.CONTEST_MANAGER, CONTEST_MANAGER_ABI, wallet);

  // Check ownership
  const owner = await contract.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error('ERROR: Wallet is not the contract owner');
    console.log('Owner:', owner);
    console.log('Your wallet:', wallet.address);
    process.exit(1);
  }
  console.log('Owner check: PASSED');

  // Get current value
  const currentMin = await contract.minPrizeValueWei();
  console.log('Current Min:', ethers.formatEther(currentMin), 'ETH');

  // Get ETH price for reference
  const chainlink = new ethers.Contract(CONFIG.CHAINLINK_ETH_USD, [
    'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'
  ], provider);
  const roundData = await chainlink.latestRoundData();
  const ethPriceUSD = Number(roundData[1]) / 1e8;
  console.log('ETH Price: $' + ethPriceUSD.toFixed(2));
  console.log('Current Min USD: $' + (Number(ethers.formatEther(currentMin)) * ethPriceUSD).toFixed(4));
  console.log('');

  // Calculate new value
  const newMinWei = ethers.parseEther(CONFIG.NEW_MIN_ETH);
  const newMinUSD = Number(CONFIG.NEW_MIN_ETH) * ethPriceUSD;

  console.log('=== New Value ===');
  console.log('New Min:', CONFIG.NEW_MIN_ETH, 'ETH');
  console.log('New Min Wei:', newMinWei.toString());
  console.log('New Min USD: $' + newMinUSD.toFixed(4));
  console.log('');

  // Confirm
  console.log('Sending transaction...');

  try {
    const tx = await contract.setMinPrizeValue(newMinWei);
    console.log('TX Hash:', tx.hash);
    console.log('Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log('');
    console.log('SUCCESS!');
    console.log('Block:', receipt.blockNumber);
    console.log('Gas Used:', receipt.gasUsed.toString());

    // Verify new value
    const verifyMin = await contract.minPrizeValueWei();
    console.log('');
    console.log('Verified New Min:', ethers.formatEther(verifyMin), 'ETH');

  } catch (error) {
    console.error('Transaction failed:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
