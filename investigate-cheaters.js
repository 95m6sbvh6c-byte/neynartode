const wallets = {
  'liadavid': ['0xb518bbf70f4fbb51420c6766e237b70758ef331b', '0xff2fb07fa9dec99af5c7b7891b4d107d7c73642e'],
  'ayeshawaqas': ['0xe1dcb3cd01168db52f29172388fb5a41a7c32288', '0xb4096c16cc31b6aeb0f1c35a216cdfa368bb7fd5', '0xd9007773e6e0e884af92b338957d4bf704231b4b'],
  'futurepicker': ['0x0e6d70a309532f175ca27bad144799ec1d5b702a'],
  'lunamarsh': ['0x2b8c2e98b13df3db73deb22fefde064976bbd743', '0xa4559a8f5edb9a82dfdcba491d9a1fa79fa66c70', '0x3a75644801095a66a53d0542de89a7ab096d6a6e']
};

const allWallets = [];
for (const [user, addrs] of Object.entries(wallets)) {
  for (const addr of addrs) {
    allWallets.push({ user, addr: addr.toLowerCase() });
  }
}

const suspectAddrs = allWallets.map(w => w.addr);
const BASESCAN_API_KEY = 'VEHI6VBT7BIHHMWIRC7XXWP31S1ANQBHKJ';

async function checkEthTransfers() {
  console.log('=== CHECKING ETH TRANSFERS BETWEEN SUSPECTS ===\n');

  const foundTransfers = [];

  for (const wallet of allWallets) {
    try {
      const url = `https://api.basescan.org/api?module=account&action=txlist&address=${wallet.addr}&startblock=0&endblock=99999999&sort=desc&apikey=${BASESCAN_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.result && Array.isArray(data.result)) {
        const suspiciousTxs = data.result.filter(tx => {
          const to = (tx.to || '').toLowerCase();
          const from = (tx.from || '').toLowerCase();
          // Both sender and receiver are in our suspect list, and they're different
          return suspectAddrs.includes(to) && suspectAddrs.includes(from) && to !== from;
        });

        for (const tx of suspiciousTxs) {
          // Avoid duplicates
          if (!foundTransfers.find(t => t.hash === tx.hash)) {
            foundTransfers.push({
              hash: tx.hash,
              from: tx.from.toLowerCase(),
              to: tx.to.toLowerCase(),
              value: tx.value,
              timestamp: tx.timeStamp
            });
          }
        }
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log('Error checking ' + wallet.user + ': ' + e.message);
    }
  }

  // Display results
  if (foundTransfers.length > 0) {
    console.log(`FOUND ${foundTransfers.length} ETH TRANSFERS BETWEEN SUSPECTS:\n`);
    foundTransfers.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

    for (const tx of foundTransfers) {
      const fromUser = allWallets.find(w => w.addr === tx.from)?.user || 'unknown';
      const toUser = allWallets.find(w => w.addr === tx.to)?.user || 'unknown';
      const value = (Number(tx.value) / 1e18).toFixed(6);
      const date = new Date(Number(tx.timestamp) * 1000).toISOString().split('T')[0];
      console.log(`${date}: ${fromUser} -> ${toUser} = ${value} ETH`);
      console.log(`  TX: ${tx.hash}`);
    }
  } else {
    console.log('No ETH transfers found between suspect wallets.');
  }

  return foundTransfers;
}

async function checkTokenTransfers() {
  console.log('\n=== CHECKING ERC20 TOKEN TRANSFERS BETWEEN SUSPECTS ===\n');

  const foundTransfers = [];

  for (const wallet of allWallets) {
    try {
      const url = `https://api.basescan.org/api?module=account&action=tokentx&address=${wallet.addr}&startblock=0&endblock=99999999&sort=desc&apikey=${BASESCAN_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.result && Array.isArray(data.result)) {
        const suspiciousTxs = data.result.filter(tx => {
          const to = (tx.to || '').toLowerCase();
          const from = (tx.from || '').toLowerCase();
          return suspectAddrs.includes(to) && suspectAddrs.includes(from) && to !== from;
        });

        for (const tx of suspiciousTxs) {
          if (!foundTransfers.find(t => t.hash === tx.hash && t.token === tx.contractAddress)) {
            foundTransfers.push({
              hash: tx.hash,
              from: tx.from.toLowerCase(),
              to: tx.to.toLowerCase(),
              value: tx.value,
              decimals: tx.tokenDecimal,
              symbol: tx.tokenSymbol,
              token: tx.contractAddress,
              timestamp: tx.timeStamp
            });
          }
        }
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log('Error checking ' + wallet.user + ': ' + e.message);
    }
  }

  if (foundTransfers.length > 0) {
    console.log(`FOUND ${foundTransfers.length} TOKEN TRANSFERS BETWEEN SUSPECTS:\n`);
    foundTransfers.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

    for (const tx of foundTransfers) {
      const fromUser = allWallets.find(w => w.addr === tx.from)?.user || 'unknown';
      const toUser = allWallets.find(w => w.addr === tx.to)?.user || 'unknown';
      const decimals = Number(tx.decimals) || 18;
      const value = (Number(tx.value) / Math.pow(10, decimals)).toFixed(2);
      const date = new Date(Number(tx.timestamp) * 1000).toISOString().split('T')[0];
      console.log(`${date}: ${fromUser} -> ${toUser} = ${value} ${tx.symbol}`);
    }
  } else {
    console.log('No token transfers found between suspect wallets.');
  }

  return foundTransfers;
}

async function main() {
  const ethTransfers = await checkEthTransfers();
  const tokenTransfers = await checkTokenTransfers();

  console.log('\n=== SUMMARY ===');
  console.log(`ETH transfers between suspects: ${ethTransfers.length}`);
  console.log(`Token transfers between suspects: ${tokenTransfers.length}`);

  if (ethTransfers.length > 0 || tokenTransfers.length > 0) {
    console.log('\n⚠️  SUSPICIOUS ACTIVITY DETECTED - These wallets are transferring funds to each other!');
  }
}

main();
