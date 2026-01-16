/**
 * Update Custom Token Fee
 * Changes the fee from 0.005 ETH to 0.001 ETH
 */

const { ethers } = require('ethers');

const CONFIG = {
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC'
};

const ABI = [
  'function customTokenFee() external view returns (uint256)',
  'function updateCustomTokenFee(uint256 _fee) external',
  'function owner() view returns (address)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC);
  const contract = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, provider);
  
  // Check current fee
  const currentFee = await contract.customTokenFee();
  console.log('Current fee:', ethers.formatEther(currentFee), 'ETH');
  
  const newFee = ethers.parseEther('0.001');
  console.log('New fee:', ethers.formatEther(newFee), 'ETH');
  
  if (!process.env.PRIVATE_KEY) {
    console.log('\n❌ PRIVATE_KEY not set. Run: source .env.local');
    console.log('\nTo update, run:');
    console.log('  source .env.local && node update-fee.js');
    return;
  }
  
  const privateKey = process.env.PRIVATE_KEY.trim().replace(/\\n/g, '');
  const wallet = new ethers.Wallet(privateKey, provider);
  const owner = await contract.owner();
  
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.log('\n❌ Your wallet is not the owner!');
    console.log('Owner:', owner);
    console.log('Your wallet:', wallet.address);
    return;
  }
  
  console.log('\n✅ Wallet verified as owner');
  console.log('Updating fee...');
  
  const contractSigner = new ethers.Contract(CONFIG.CONTEST_ESCROW, ABI, wallet);
  const tx = await contractSigner.updateCustomTokenFee(newFee);
  console.log('TX:', tx.hash);
  
  const receipt = await tx.wait();
  console.log('✅ Fee updated in block', receipt.blockNumber);
  
  // Verify
  const updatedFee = await contract.customTokenFee();
  console.log('Verified new fee:', ethers.formatEther(updatedFee), 'ETH');
}

main().catch(console.error);
