/**
 * Update VRF Config Script
 *
 * Increases the callback gas limit to prevent out-of-gas failures
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/update-vrf-config.js
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',

  // VRF Config - these are the current values from your contract
  SUBSCRIPTION_ID: '72373914629070626758366646415378524614479427696925017993005309257294247414075',
  KEY_HASH: '0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897', // Base VRF key hash
  CALLBACK_GAS_LIMIT: 250000, // INCREASED from 100000
  REQUEST_CONFIRMATIONS: 3
};

const ABI = [
  'function updateVRFConfig(uint256 _subscriptionId, bytes32 _keyHash, uint32 _callbackGasLimit, uint16 _requestConfirmations) external',
  'function callbackGasLimit() view returns (uint32)',
  'function keyHash() view returns (bytes32)',
  'function subscriptionId() view returns (uint256)',
  'function requestConfirmations() view returns (uint16)',
  'function owner() view returns (address)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);

  // Check current config first
  const contractRead = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, provider);

  console.log('=== Current VRF Config ===');
  const currentGasLimit = await contractRead.callbackGasLimit();
  const currentKeyHash = await contractRead.keyHash();
  const currentSubId = await contractRead.subscriptionId();
  const currentConfirmations = await contractRead.requestConfirmations();
  const owner = await contractRead.owner();

  console.log('Subscription ID:', currentSubId.toString());
  console.log('Key Hash:', currentKeyHash);
  console.log('Callback Gas Limit:', currentGasLimit.toString());
  console.log('Request Confirmations:', currentConfirmations.toString());
  console.log('Owner:', owner);
  console.log('');

  // Check gas prices
  const feeData = await provider.getFeeData();
  console.log('=== Current Gas Prices ===');
  console.log('Gas Price:', ethers.formatUnits(feeData.gasPrice, 'gwei'), 'gwei');
  console.log('Max Fee:', ethers.formatUnits(feeData.maxFeePerGas || 0n, 'gwei'), 'gwei');
  console.log('');

  // Estimate costs
  const estimatedGas = 50000n; // updateVRFConfig is a simple storage update
  const txCost = estimatedGas * feeData.gasPrice;
  console.log('=== Estimated Costs ===');
  console.log('Update VRF Config TX: ~', ethers.formatEther(txCost), 'ETH');
  console.log('');

  // VRF callback cost estimation
  const vrfCallbackCost = BigInt(CONFIG.CALLBACK_GAS_LIMIT) * feeData.gasPrice;
  console.log('VRF Callback (250k gas): ~', ethers.formatEther(vrfCallbackCost), 'ETH per contest');
  console.log('');

  if (!process.env.PRIVATE_KEY) {
    console.log('=== DRY RUN (no PRIVATE_KEY) ===');
    console.log('To execute, run with: PRIVATE_KEY=0x... node scripts/update-vrf-config.js');
    console.log('');
    console.log('New config to be applied:');
    console.log('  Callback Gas Limit: 100000 -> 250000');
    return;
  }

  // Execute update
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('Wallet address:', wallet.address);

  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error('ERROR: Wallet is not the contract owner!');
    console.error('Owner:', owner);
    console.error('Your wallet:', wallet.address);
    return;
  }

  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, wallet);

  console.log('');
  console.log('=== Executing Update ===');
  console.log('Updating callback gas limit: 100000 -> 250000');

  const tx = await contract.updateVRFConfig(
    CONFIG.SUBSCRIPTION_ID,
    currentKeyHash, // Keep same key hash
    CONFIG.CALLBACK_GAS_LIMIT,
    CONFIG.REQUEST_CONFIRMATIONS
  );

  console.log('TX submitted:', tx.hash);
  console.log('Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log('Confirmed in block:', receipt.blockNumber);
  console.log('Gas used:', receipt.gasUsed.toString());
  console.log('Actual cost:', ethers.formatEther(receipt.gasUsed * receipt.gasPrice), 'ETH');

  // Verify update
  const newGasLimit = await contractRead.callbackGasLimit();
  console.log('');
  console.log('=== Verified ===');
  console.log('New callback gas limit:', newGasLimit.toString());
}

main().catch(console.error);
