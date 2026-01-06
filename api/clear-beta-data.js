/**
 * Clear Beta Data API
 *
 * Clears all beta season (season 2) data from KV storage for a fresh start.
 * This includes:
 * - Season index
 * - Contest caches
 * - Contest entries
 * - Leaderboard caches
 * - Announcement flags
 * - Finalization tx hashes
 *
 * Usage:
 *   POST /api/clear-beta-data?confirm=yes
 *
 * Security: Requires admin authorization
 */

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require confirmation
  if (req.query.confirm !== 'yes') {
    return res.status(400).json({
      error: 'Missing confirmation',
      message: 'Add ?confirm=yes to proceed with clearing all beta data'
    });
  }

  // Require admin authorization
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== 'Bearer neynartodes-admin-clear') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(500).json({ error: 'KV storage not configured' });
  }

  try {
    const { kv } = require('@vercel/kv');
    const deleted = {
      seasonIndex: 0,
      contestCaches: 0,
      contestEntries: 0,
      entryRecords: 0,
      leaderboards: 0,
      announcements: 0,
      finalizeTx: 0,
      messages: 0,
      nftCaches: 0,
      socialData: 0,
    };

    console.log('Starting beta data cleanup...');

    // 1. Clear season index
    const seasonId = 2;
    const indexKey = `season:${seasonId}:contests`;
    const indexExists = await kv.exists(indexKey);
    if (indexExists) {
      await kv.del(indexKey);
      deleted.seasonIndex = 1;
      console.log('Deleted season index');
    }

    // 2. Clear leaderboard caches
    const leaderboardKeys = [
      `leaderboard:s${seasonId}:l10`,
      `leaderboard:s${seasonId}:l25`,
      `leaderboard:s${seasonId}:l50`,
      `leaderboard:current`,
    ];
    for (const key of leaderboardKeys) {
      const exists = await kv.exists(key);
      if (exists) {
        await kv.del(key);
        deleted.leaderboards++;
      }
    }
    console.log(`Deleted ${deleted.leaderboards} leaderboard caches`);

    // 3. Clear contest caches and entries for V1 token contests (1-200)
    for (let i = 1; i <= 200; i++) {
      // Contest cache
      const cacheKey = `contest:token:${i}`;
      if (await kv.exists(cacheKey)) {
        await kv.del(cacheKey);
        deleted.contestCaches++;
      }

      // Contest entries set
      const entriesKey = `contest_entries:${i}`;
      if (await kv.exists(entriesKey)) {
        await kv.del(entriesKey);
        deleted.contestEntries++;
      }

      // Announcement flags
      const announcedKey = `announced_${i}`;
      if (await kv.exists(announcedKey)) {
        await kv.del(announcedKey);
        deleted.announcements++;
      }

      // Finalize tx
      const finalizeTxKey = `finalize_tx_${i}`;
      if (await kv.exists(finalizeTxKey)) {
        await kv.del(finalizeTxKey);
        deleted.finalizeTx++;
      }

      // Contest message
      const messageKey = `contest_message_${i}`;
      if (await kv.exists(messageKey)) {
        await kv.del(messageKey);
        deleted.messages++;
      }

      // Social data
      const socialKey = `contest:social:token-${i}`;
      if (await kv.exists(socialKey)) {
        await kv.del(socialKey);
        deleted.socialData++;
      }
    }
    console.log('Cleared V1 token contest data');

    // 4. Clear V2 contest data (105-400)
    for (let i = 105; i <= 400; i++) {
      // Contest cache
      const cacheKey = `contest:v2:${i}`;
      if (await kv.exists(cacheKey)) {
        await kv.del(cacheKey);
        deleted.contestCaches++;
      }

      // Contest entries set (both formats)
      for (const prefix of ['v2-', 'V2-', '']) {
        const entriesKey = `contest_entries:${prefix}${i}`;
        if (await kv.exists(entriesKey)) {
          await kv.del(entriesKey);
          deleted.contestEntries++;
        }
      }

      // Announcement flags
      const announcedKey = `announced_v2_${i}`;
      if (await kv.exists(announcedKey)) {
        await kv.del(announcedKey);
        deleted.announcements++;
      }

      // Finalize tx
      const finalizeTxKey = `finalize_tx_v2_${i}`;
      if (await kv.exists(finalizeTxKey)) {
        await kv.del(finalizeTxKey);
        deleted.finalizeTx++;
      }

      // Social data
      const socialKey = `contest:social:v2-${i}`;
      if (await kv.exists(socialKey)) {
        await kv.del(socialKey);
        deleted.socialData++;
      }
    }
    console.log('Cleared V2 contest data');

    // 5. Clear NFT contest data (1-100)
    for (let i = 1; i <= 100; i++) {
      // Contest cache
      const cacheKey = `contest:nft:${i}`;
      if (await kv.exists(cacheKey)) {
        await kv.del(cacheKey);
        deleted.contestCaches++;
      }

      // NFT metadata cache
      const nftCacheKey = `nft:contest:${i}`;
      if (await kv.exists(nftCacheKey)) {
        await kv.del(nftCacheKey);
        deleted.nftCaches++;
      }

      // Contest entries set
      for (const prefix of ['nft-', 'NFT-']) {
        const entriesKey = `contest_entries:${prefix}${i}`;
        if (await kv.exists(entriesKey)) {
          await kv.del(entriesKey);
          deleted.contestEntries++;
        }
      }

      // Announcement flags
      const announcedKey = `announced_nft_${i}`;
      if (await kv.exists(announcedKey)) {
        await kv.del(announcedKey);
        deleted.announcements++;
      }

      // Finalize tx
      const finalizeTxKey = `finalize_tx_nft_${i}`;
      if (await kv.exists(finalizeTxKey)) {
        await kv.del(finalizeTxKey);
        deleted.finalizeTx++;
      }

      // Social data
      const socialKey = `contest:social:nft-${i}`;
      if (await kv.exists(socialKey)) {
        await kv.del(socialKey);
        deleted.socialData++;
      }
    }
    console.log('Cleared NFT contest data');

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`Beta data cleanup complete: ${totalDeleted} keys deleted`);

    return res.status(200).json({
      success: true,
      message: `Beta season data cleared successfully`,
      deleted,
      totalDeleted,
    });

  } catch (error) {
    console.error('Clear beta data error:', error);
    return res.status(500).json({ error: error.message });
  }
};
