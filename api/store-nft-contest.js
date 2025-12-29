/**
 * Store NFT Contest Data API
 *
 * Caches complete NFT metadata for a contest so we don't need to fetch it again.
 * Called when an NFT contest is created.
 * Used by: Share button, entry display, notification system, active contest page, history tab.
 *
 * POST /api/store-nft-contest
 * Body: {
 *   contestId: "123",
 *   contractAddress: "0x...",
 *   tokenId: "78",
 *   image: "https://ipfs.io/ipfs/...",
 *   name: "mfer tv #78",
 *   collection: "mfertv",
 *   description: "NFT description...",
 *   attributes: [{ trait_type: "Background", value: "Blue" }, ...],
 *   tokenType: "ERC721",
 *   creatorFid: 12345,
 *   creatorUsername: "user.eth",
 *   entryFee: "0.001",
 *   maxEntries: 100,
 *   endTime: 1704067200000,
 *   floorPriceETH: "0.05"
 * }
 *
 * GET /api/store-nft-contest?contestId=123
 * Returns cached NFT data for the contest
 */

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  const { kv } = require('@vercel/kv');

  // GET - Retrieve cached NFT data for a contest
  if (req.method === 'GET') {
    const { contestId } = req.query;

    if (!contestId) {
      return res.status(400).json({ error: 'Missing contestId' });
    }

    try {
      const cached = await kv.get(`nft:contest:${contestId}`);

      if (!cached) {
        return res.status(404).json({
          success: false,
          error: 'No cached NFT data for this contest'
        });
      }

      return res.status(200).json({
        success: true,
        ...cached
      });

    } catch (error) {
      console.error('Error reading NFT cache:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // POST - Store NFT data for a contest
  if (req.method === 'POST') {
    const {
      contestId,
      contractAddress,
      tokenId,
      image,
      name,
      collection,
      description,
      attributes,
      tokenType,
      creatorFid,
      creatorUsername,
      creatorPfp,
      entryFee,
      maxEntries,
      endTime,
      prizeType,
      status,
      floorPriceETH
    } = req.body;

    if (!contestId) {
      return res.status(400).json({ error: 'Missing contestId' });
    }

    if (!contractAddress || !tokenId) {
      return res.status(400).json({ error: 'Missing contractAddress or tokenId' });
    }

    try {
      // Store complete NFT and contest metadata
      const cacheData = {
        // NFT metadata
        contestId,
        contractAddress,
        tokenId,
        image: image || '',
        name: name || `NFT #${tokenId}`,
        collection: collection || 'Unknown Collection',
        description: description || '',
        attributes: attributes || [],
        tokenType: tokenType || 'ERC721',

        // Creator info (for notifications and display)
        creatorFid: creatorFid || null,
        creatorUsername: creatorUsername || '',
        creatorPfp: creatorPfp || '',

        // Contest settings (for active page and history)
        entryFee: entryFee || '0',
        maxEntries: maxEntries || null,
        endTime: endTime || null,
        prizeType: prizeType || 'nft',
        status: status || 'active',
        floorPriceETH: floorPriceETH || null,

        // Timestamps
        cachedAt: Date.now(),
        createdAt: Date.now()
      };

      await kv.set(`nft:contest:${contestId}`, cacheData);

      console.log(`Cached complete NFT data for contest ${contestId}:`, {
        name: cacheData.name,
        collection: cacheData.collection,
        image: cacheData.image?.substring(0, 50) + '...',
        attributeCount: cacheData.attributes?.length || 0,
        creatorFid: cacheData.creatorFid
      });

      return res.status(200).json({
        success: true,
        ...cacheData
      });

    } catch (error) {
      console.error('Error storing NFT cache:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
