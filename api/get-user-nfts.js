/**
 * Get User NFTs API
 *
 * Fetches NFTs owned by a wallet address.
 * Uses Alchemy NFT API for reliable indexing.
 *
 * Also fetches individual NFT metadata by contract+tokenId.
 *
 * Usage:
 *   GET /api/get-user-nfts?address=0x...
 *   GET /api/get-user-nfts?address=0x...&pageKey=abc123 (for pagination)
 *   GET /api/get-user-nfts?contract=0x...&tokenId=123 (get single NFT metadata)
 */

const { ethers } = require('ethers');

// Alchemy API for NFTs (more reliable than Blockscout)
const ALCHEMY_API_KEY = 'QooWtq9nKQlkeqKF_-rvC';
const ALCHEMY_NFT_BASE_URL = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

// RPC for direct contract calls as fallback
const BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// IPFS gateways to try in order (ipfs.io is unreliable from serverless)
const IPFS_GATEWAYS = [
  'https://nftstorage.link/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
];

/**
 * Resolve an IPFS URI to an HTTP URL, trying multiple gateways
 */
function resolveIpfsUrl(uri) {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', IPFS_GATEWAYS[0]);
  if (uri.startsWith('ar://')) return uri.replace('ar://', 'https://arweave.net/');
  return uri;
}

/**
 * Fetch JSON from a URL with timeout, trying multiple IPFS gateways if needed
 */
async function fetchWithGatewayFallback(ipfsUri, timeoutMs = 8000) {
  const ipfsPath = ipfsUri.startsWith('ipfs://') ? ipfsUri.replace('ipfs://', '') : null;

  if (ipfsPath) {
    for (const gateway of IPFS_GATEWAYS) {
      try {
        const url = gateway + ipfsPath;
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return await res.json();
      } catch (e) {
        console.log(`Gateway ${gateway} failed: ${e.message}`);
      }
    }
    return null;
  }

  // Non-IPFS URL
  let url = ipfsUri;
  if (url.startsWith('ar://')) url = url.replace('ar://', 'https://arweave.net/');
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) return await res.json();
  return null;
}

// NFT ABI for direct metadata fetching
const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 id) view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
];

/**
 * Fetch single NFT metadata - uses direct contract call for fresh metadata
 * (APIs can have stale cached metadata for revealed NFTs)
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

    // Handle base64 encoded JSON (data URIs)
    if (tokenUri.startsWith('data:application/json')) {
      try {
        const base64Data = tokenUri.split(',')[1];
        const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
        const metadata = JSON.parse(jsonStr);
        let imageUrl = resolveIpfsUrl(metadata.image || '');
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

    // Fetch metadata with multi-gateway fallback for IPFS
    const metadata = await fetchWithGatewayFallback(tokenUri);

    if (!metadata) {
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

    let imageUrl = metadata.image || metadata.image_url || '';
    imageUrl = resolveIpfsUrl(imageUrl);

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
 * Fetch NFTs owned by an address using Alchemy NFT API
 */
async function getNftsForOwner(ownerAddress, pageKey = null) {
  try {
    // Alchemy NFT API endpoint
    let url = `${ALCHEMY_NFT_BASE_URL}/getNFTsForOwner?owner=${ownerAddress}&withMetadata=true&pageSize=100`;

    if (pageKey) {
      url += `&pageKey=${encodeURIComponent(pageKey)}`;
    }

    console.log(`Fetching NFTs for ${ownerAddress} via Alchemy...`);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Alchemy API error:', response.status, errorText);
      throw new Error(`Alchemy API error: ${response.status}`);
    }

    const data = await response.json();

    // Transform the Alchemy response to match our format
    const nfts = (data.ownedNfts || []).map(nft => {
      const tokenType = nft.tokenType || 'ERC721';
      const isERC1155 = tokenType === 'ERC1155';

      // Get image URL from various possible fields
      let imageUrl = nft.image?.cachedUrl ||
                     nft.image?.thumbnailUrl ||
                     nft.image?.pngUrl ||
                     nft.image?.originalUrl ||
                     nft.raw?.metadata?.image ||
                     '';

      // Resolve IPFS URLs
      if (imageUrl.startsWith('ipfs://')) {
        imageUrl = imageUrl.replace('ipfs://', 'https://nftstorage.link/ipfs/');
      }

      return {
        contractAddress: nft.contract?.address,
        tokenId: nft.tokenId,
        name: nft.name || nft.raw?.metadata?.name || `#${nft.tokenId}`,
        collection: nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || 'Unknown Collection',
        image: imageUrl,
        tokenType: isERC1155 ? 'ERC1155' : 'ERC721',
        balance: parseInt(nft.balance) || 1,
        contractName: nft.contract?.name,
        symbol: nft.contract?.symbol,
        floorPrice: nft.contract?.openSeaMetadata?.floorPrice || null,
        description: nft.description || nft.raw?.metadata?.description || '',
      };
    });

    return {
      nfts,
      pageKey: data.pageKey || null,
      totalCount: data.totalCount || nfts.length,
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
