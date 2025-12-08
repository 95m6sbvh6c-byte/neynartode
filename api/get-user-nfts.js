/**
 * Get User NFTs API
 *
 * Fetches NFTs owned by a wallet address using Alchemy's NFT API.
 * Used to provide a simplified NFT selection experience.
 *
 * Usage:
 *   GET /api/get-user-nfts?address=0x...
 *   GET /api/get-user-nfts?address=0x...&pageKey=abc123 (for pagination)
 */

// Alchemy API key - use from env or fallback to hardcoded key
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'QooWtq9nKQlkeqKF_-rvC';
const ALCHEMY_BASE_URL = `https://base-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

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

  const { address, pageKey } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Missing address parameter' });
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
