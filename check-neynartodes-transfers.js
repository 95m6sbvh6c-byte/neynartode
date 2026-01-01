const NEYNARTODES = '0x8dE1622fE07f56cda2e2273e615A513F1d828B07'.toLowerCase();
const BASESCAN_API_KEY = 'VEHI6VBT7BIHHMWIRC7XXWP31S1ANQBHKJ';

const suspects = {
  'liadavid': ['0xb518bbf70f4fbb51420c6766e237b70758ef331b', '0xff2fb07fa9dec99af5c7b7891b4d107d7c73642e'],
  'ayeshawaqas': ['0xe1dcb3cd01168db52f29172388fb5a41a7c32288', '0xb4096c16cc31b6aeb0f1c35a216cdfa368bb7fd5', '0xd9007773e6e0e884af92b338957d4bf704231b4b'],
  'futurepicker': ['0x0e6d70a309532f175ca27bad144799ec1d5b702a'],
  'lunamarsh': ['0x2b8c2e98b13df3db73deb22fefde064976bbd743', '0xa4559a8f5edb9a82dfdcba491d9a1fa79fa66c70', '0x3a75644801095a66a53d0542de89a7ab096d6a6e']
};

const allWallets = [];
for (const [user, addrs] of Object.entries(suspects)) {
  for (const addr of addrs) {
    allWallets.push({ user, addr: addr.toLowerCase() });
  }
}
const suspectAddrs = allWallets.map(w => w.addr);

async function main() {
  console.log('=== SEARCHING FOR NEYNARTODES TRANSFERS ===\n');

  const allTransfers = [];
  const transfersBetweenSuspects = [];

  for (const wallet of allWallets) {
    console.log(`Checking @${wallet.user} (${wallet.addr.substring(0, 10)}...)...`);

    try {
      const url = `https://api.basescan.org/api?module=account&action=tokentx&address=${wallet.addr}&contractaddress=${NEYNARTODES}&startblock=0&endblock=99999999&sort=desc&apikey=${BASESCAN_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.result && Array.isArray(data.result)) {
        console.log(`  Found ${data.result.length} NEYNARTODES transactions`);

        for (const tx of data.result) {
          const from = tx.from.toLowerCase();
          const to = tx.to.toLowerCase();

          // Check if transfer is between suspects
          const fromIsSuspect = suspectAddrs.includes(from);
          const toIsSuspect = suspectAddrs.includes(to);

          if (fromIsSuspect && toIsSuspect && from !== to) {
            if (!transfersBetweenSuspects.find(t => t.hash === tx.hash)) {
              transfersBetweenSuspects.push({
                hash: tx.hash,
                from,
                to,
                value: tx.value,
                timestamp: tx.timeStamp
              });
            }
          }

          // Track all transfers for analysis
          allTransfers.push({
            hash: tx.hash,
            from,
            to,
            value: tx.value,
            timestamp: tx.timeStamp,
            wallet: wallet.user
          });
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log('\n=== NEYNARTODES TRANSFERS BETWEEN SUSPECTS ===\n');

  if (transfersBetweenSuspects.length > 0) {
    transfersBetweenSuspects.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

    for (const tx of transfersBetweenSuspects) {
      const fromUser = allWallets.find(w => w.addr === tx.from)?.user || 'unknown';
      const toUser = allWallets.find(w => w.addr === tx.to)?.user || 'unknown';
      const amount = (Number(tx.value) / 1e18).toLocaleString();
      const date = new Date(Number(tx.timestamp) * 1000).toISOString().split('T')[0];

      console.log(`${date}: @${fromUser} -> @${toUser}: ${amount} NEYNARTODES`);
      console.log(`  TX: https://basescan.org/tx/${tx.hash}`);
    }

    console.log(`\n⚠️  FOUND ${transfersBetweenSuspects.length} NEYNARTODES transfers between suspect wallets!`);
  } else {
    console.log('No NEYNARTODES transfers found between suspect wallets.');
  }

  // Check for common funding sources
  console.log('\n=== CHECKING FOR COMMON FUNDING SOURCES ===\n');

  const fundingSources = {};
  for (const tx of allTransfers) {
    if (!suspectAddrs.includes(tx.from)) {
      // External source
      if (!fundingSources[tx.from]) {
        fundingSources[tx.from] = [];
      }
      const wallet = allWallets.find(w => w.addr === tx.to);
      if (wallet && !fundingSources[tx.from].includes(wallet.user)) {
        fundingSources[tx.from].push(wallet.user);
      }
    }
  }

  // Find sources that funded multiple suspects
  const commonSources = Object.entries(fundingSources).filter(([addr, users]) => users.length > 1);

  if (commonSources.length > 0) {
    console.log('Found external wallets that sent NEYNARTODES to multiple suspects:');
    for (const [addr, users] of commonSources) {
      console.log(`  ${addr.substring(0, 12)}... -> ${users.join(', ')}`);
    }
  } else {
    console.log('No common external funding sources found.');
  }
}

main();
