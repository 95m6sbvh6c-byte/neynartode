/**
 * Get User NFTs API
 *
 * Fetches NFTs owned by a wallet address.
 * Uses Blockscout API (Base's official explorer - free, no key needed).
 *
 * Also fetches individual NFT metadata by contract+tokenId.
 *
 * Usage:
 *   GET /api/get-user-nfts?address=0x...
 *   GET /api/get-user-nfts?address=0x...&pageKey=abc123 (for pagination)
 *   GET /api/get-user-nfts?contract=0x...&tokenId=123 (get single NFT metadata)
 */

const { ethers } = require('ethers');

// Blockscout API (Base's official explorer - free, no API key needed)
const BLOCKSCOUT_BASE_URL = 'https://base.blockscout.com/api/v2';

// RPC for direct contract calls as fallback
const BASE_RPC = 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/';

// NFT ABI for direct metadata fetching
const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 id) view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
];

/**
 * Fetch single NFT metadata - uses direct contract call for fresh metadata
 * (Blockscout can have stale cached metadata for revealed NFTs)
 */
async function getNftMetadata(contractAddress, tokenId) {
  console.log(`Fetching NFT metadata for ${contractAddress} #${tokenId} via direct contract call...`);

  // Always use direct contract call for single NFT lookups
  // This ensures we get fresh metadata (important for revealed NFTs)
  return await getNftMetadataFromContract(contractAddress, tokenId);
}

/**
 * Fetch NFT metadata directly from contract
 */
async function getNftMetadataFromContract(contractAddress, tokenId) {
  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const contract = new ethers.Contract(contractAddress, NFT_ABI, provider);

    // Get collection name
    let collectionName = 'NFT Collection';
    try {
      collectionName = await contract.name();
    } catch (e) {}

    // Try tokenURI (ERC721) first, then uri (ERC1155)
    let tokenUri = '';
    let tokenType = 'ERC721';
    try {
      tokenUri = await contract.tokenURI(tokenId);
    } catch (e) {
      try {
        tokenUri = await contract.uri(tokenId);
        tokenType = 'ERC1155';
        tokenUri = tokenUri.replace('{id}', tokenId.toString().padStart(64, '0'));
      } catch (e2) {
        return {
          success: true,
          contractAddress,
          tokenId,
          name: `${collectionName} #${tokenId}`,
          collection: collectionName,
          image: '',
          tokenType,
          description: '',
          attributes: [],
          floorPrice: null,
        };
      }
    }

    // Resolve metadata URL
    let metadataUrl = tokenUri;
    if (tokenUri.startsWith('ipfs://')) {
      metadataUrl = tokenUri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
    } else if (tokenUri.startsWith('ar://')) {
      metadataUrl = tokenUri.replace('ar://', 'https://arweave.net/');
    } else if (tokenUri.startsWith('data:application/json')) {
      // Handle base64 encoded JSON
      try {
        const base64Data = tokenUri.split(',')[1];
        const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
        const metadata = JSON.parse(jsonStr);
        let imageUrl = metadata.image || '';
        if (imageUrl.startsWith('ipfs://')) {
          imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
        }
        return {
          success: true,
          contractAddress,
          tokenId,
          name: metadata.name || `${collectionName} #${tokenId}`,
          collection: collectionName,
          image: imageUrl,
          tokenType,
          description: metadata.description || '',
          attributes: metadata.attributes || [],
          floorPrice: null,
        };
      } catch (e) {
        return {
          success: true,
          contractAddress,
          tokenId,
          name: `${collectionName} #${tokenId}`,
          collection: collectionName,
          image: '',
          tokenType,
          description: '',
          attributes: [],
          floorPrice: null,
        };
      }
    }

    // Fetch metadata from URL
    const metaResponse = await fetch(metadataUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (!metaResponse.ok) {
      return {
        success: true,
        contractAddress,
        tokenId,
        name: `${collectionName} #${tokenId}`,
        collection: collectionName,
        image: '',
        tokenType,
        description: '',
        attributes: [],
        floorPrice: null,
      };
    }

    const metadata = await metaResponse.json();
    let imageUrl = metadata.image || metadata.image_url || '';
    if (imageUrl.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
    }

    return {
      success: true,
      contractAddress,
      tokenId,
      name: metadata.name || `${collectionName} #${tokenId}`,
      collection: collectionName,
      image: imageUrl,
      tokenType,
      description: metadata.description || '',
      attributes: metadata.attributes || [],
      floorPrice: null,
    };

  } catch (error) {
    console.error('Error in direct contract call:', error);
    return {
      success: true,
      contractAddress,
      tokenId,
      name: `NFT #${tokenId}`,
      collection: 'Unknown Collection',
      image: '',
      tokenType: 'ERC721',
      description: '',
      attributes: [],
      floorPrice: null,
    };
  }
}

/**
 * Fetch NFTs owned by an address using Blockscout API (free, no key needed)
 */
async function getNftsForOwner(ownerAddress, cursor = null) {
  try {
    // Blockscout NFT endpoint for address
    let url = `${BLOCKSCOUT_BASE_URL}/addresses/${ownerAddress}/nft?type=ERC-721,ERC-1155`;

    // Blockscout uses different pagination params
    if (cursor) {
      // cursor format: "token_hash:id" from next_page_params
      url += `&${cursor}`;
    }

    console.log(`Fetching NFTs for ${ownerAddress} via Blockscout...`);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Blockscout API error:', response.status, errorText);
      throw new Error(`Blockscout API error: ${response.status}`);
    }

    const data = await response.json();

    // Transform the Blockscout response to match our format
    const nfts = (data.items || []).map(nft => {
      const tokenType = nft.token?.type || nft.token_type || 'ERC-721';
      const isERC1155 = tokenType.includes('1155');

      let imageUrl = nft.image_url || '';
      if (imageUrl.startsWith('ipfs://')) {
        imageUrl = imageUrl.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
      }

      return {
        contractAddress: nft.token?.address_hash || nft.token?.address,
        tokenId: nft.id,
        name: nft.metadata?.name || `#${nft.id}`,
        collection: nft.token?.name || 'Unknown Collection',
        image: imageUrl,
        tokenType: isERC1155 ? 'ERC1155' : 'ERC721',
        balance: parseInt(nft.value) || 1,
        contractName: nft.token?.name,
        symbol: nft.token?.symbol,
        floorPrice: null,
      };
    });

    // Build pagination cursor from next_page_params if present
    let pageKey = null;
    if (data.next_page_params) {
      const params = new URLSearchParams();
      Object.entries(data.next_page_params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          params.append(key, value);
        }
      });
      pageKey = params.toString();
    }

    return {
      nfts,
      pageKey,
      totalCount: nfts.length,
    };

  } catch (error) {
    console.error('Error fetching NFTs:', error);
    throw error;
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, pageKey, continuation, contract, tokenId } = req.query;

  // Mode 1: Get single NFT metadata by contract + tokenId
  if (contract && tokenId) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return res.status(400).json({ error: 'Invalid contract address format' });
    }

    try {
      const result = await getNftMetadata(contract, tokenId);
      return res.status(200).json(result);
    } catch (error) {
      console.error('API error:', error);
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  // Mode 2: Get all NFTs for a wallet address
  if (!address) {
    return res.status(400).json({ error: 'Missing address parameter (or use contract+tokenId for single NFT)' });
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }

  try {
    // Support both pageKey (old) and continuation (new) for backwards compatibility
    const result = await getNftsForOwner(address, continuation || pageKey);

    return res.status(200).json({
      success: true,
      address,
      ...result,
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
