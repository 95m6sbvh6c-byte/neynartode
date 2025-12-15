/**
 * Get User NFTs API
 *
 * Fetches NFTs owned by a wallet address using Alchemy's NFT API.
 * Used to provide a simplified NFT selection experience.
 *
 * Also fetches individual NFT metadata by contract+tokenId.
 *
 * Usage:
 *   GET /api/get-user-nfts?address=0x...
 *   GET /api/get-user-nfts?address=0x...&pageKey=abc123 (for pagination)
 *   GET /api/get-user-nfts?contract=0x...&tokenId=123 (get single NFT metadata)
 */

// Alchemy API key - use from env or fallback to hardcoded key
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'QooWtq9nKQlkeqKF_-rvC';
const ALCHEMY_BASE_URL = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

/**
 * Fetch single NFT metadata using Alchemy NFT API
 * Includes floor price from OpenSea metadata
 */
async function getNftMetadata(contractAddress, tokenId) {
  try {
    // Fetch NFT metadata and contract metadata in parallel
    const [nftUrl, contractUrl] = [
      `${ALCHEMY_BASE_URL}/getNFTMetadata?contractAddress=${contractAddress}&tokenId=${tokenId}&refreshCache=false`,
      `${ALCHEMY_BASE_URL}/getContractMetadata?contractAddress=${contractAddress}`
    ];

    console.log(`Fetching NFT metadata for ${contractAddress} #${tokenId}...`);

    const [nftResponse, contractResponse] = await Promise.all([
      fetch(nftUrl),
      fetch(contractUrl).catch(() => null) // Don't fail if contract metadata unavailable
    ]);

    if (!nftResponse.ok) {
      const errorText = await nftResponse.text();
      console.error('Alchemy API error:', errorText);
      throw new Error(`Alchemy API error: ${nftResponse.status}`);
    }

    const nft = await nftResponse.json();

    // Get floor price from contract metadata (more reliable than NFT metadata)
    let floorPrice = nft.contract?.openSeaMetadata?.floorPrice || null;
    if (contractResponse && contractResponse.ok) {
      const contractData = await contractResponse.json();
      floorPrice = contractData.openSeaMetadata?.floorPrice || floorPrice;
    }

    // Get the best image URL
    let imageUrl = nft.image?.cachedUrl ||
                   nft.image?.thumbnailUrl ||
                   nft.image?.pngUrl ||
                   nft.image?.originalUrl ||
                   nft.raw?.metadata?.image ||
                   null;

    // Handle IPFS URLs
    if (imageUrl && imageUrl.startsWith('ipfs://')) {
      imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    return {
      success: true,
      contractAddress: nft.contract?.address,
      tokenId: nft.tokenId,
      name: nft.name || nft.raw?.metadata?.name || `#${tokenId}`,
      collection: nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || 'Unknown Collection',
      image: imageUrl,
      tokenType: nft.contract?.tokenType || 'ERC721',
      description: nft.description || nft.raw?.metadata?.description || '',
      attributes: nft.raw?.metadata?.attributes || [],
      floorPrice: floorPrice, // Floor price in ETH (from OpenSea)
    };

  } catch (error) {
    console.error('Error fetching NFT metadata:', error);
    throw error;
  }
}

/**
 * Fetch NFTs owned by an address using Alchemy NFT API
 */
async function getNftsForOwner(ownerAddress, pageKey = null) {
  try {
    let url = `${ALCHEMY_BASE_URL}/getNFTsForOwner?owner=${ownerAddress}&withMetadata=true&pageSize=50`;

    // Add pagination key if provided
    if (pageKey) {
      url += `&pageKey=${pageKey}`;
    }

    // Exclude spam NFTs
    url += '&excludeFilters[]=SPAM';

    console.log(`Fetching NFTs for ${ownerAddress}...`);

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Alchemy API error:', errorText);
      throw new Error(`Alchemy API error: ${response.status}`);
    }

    const data = await response.json();

    // Transform the response to a simpler format
    const nfts = (data.ownedNfts || []).map(nft => {
      // Determine NFT type
      const tokenType = nft.contract?.tokenType || 'ERC721';
      const isERC1155 = tokenType === 'ERC1155';

      // Get the best image URL
      let imageUrl = nft.image?.cachedUrl ||
                     nft.image?.thumbnailUrl ||
                     nft.image?.originalUrl ||
                     nft.raw?.metadata?.image ||
                     null;

      // Handle IPFS URLs
      if (imageUrl && imageUrl.startsWith('ipfs://')) {
        imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }

      return {
        contractAddress: nft.contract?.address,
        tokenId: nft.tokenId,
        name: nft.name || nft.raw?.metadata?.name || `#${nft.tokenId}`,
        collection: nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || 'Unknown Collection',
        image: imageUrl,
        tokenType: tokenType,
        balance: isERC1155 ? parseInt(nft.balance || '1') : 1,
        // Include contract-level info
        contractName: nft.contract?.name,
        symbol: nft.contract?.symbol,
        floorPrice: nft.contract?.openSeaMetadata?.floorPrice,
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

  const { address, pageKey, contract, tokenId } = req.query;

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
    const result = await getNftsForOwner(address, pageKey);

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
