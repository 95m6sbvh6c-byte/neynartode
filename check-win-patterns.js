const suspects = {
  'liadavid': {
    fid: 892902,
    wallets: ['0xb518bbf70f4fbb51420c6766e237b70758ef331b', '0xff2fb07fa9dec99af5c7b7891b4d107d7c73642e']
  },
  'ayeshawaqas': {
    fid: 533329,
    wallets: ['0xe1dcb3cd01168db52f29172388fb5a41a7c32288', '0xb4096c16cc31b6aeb0f1c35a216cdfa368bb7fd5', '0xd9007773e6e0e884af92b338957d4bf704231b4b']
  },
  'futurepicker': {
    fid: 940217,
    wallets: ['0x0e6d70a309532f175ca27bad144799ec1d5b702a']
  },
  'lunamarsh': {
    fid: 874752,
    wallets: ['0x2b8c2e98b13df3db73deb22fefde064976bbd743', '0xa4559a8f5edb9a82dfdcba491d9a1fa79fa66c70', '0x3a75644801095a66a53d0542de89a7ab096d6a6e']
  }
};

// All wallets to check
const allWallets = [];
for (const [username, data] of Object.entries(suspects)) {
  for (const wallet of data.wallets) {
    allWallets.push({ username, wallet: wallet.toLowerCase() });
  }
}

async function fetchContestHistory() {
  // Fetch completed contests
  const response = await fetch('https://frame-opal-eight.vercel.app/api/contest-history?status=history&limit=50');
  const data = await response.json();
  return data.contests || [];
}

async function main() {
  console.log('=== CHECKING CONTEST WIN PATTERNS ===\n');

  const contests = await fetchContestHistory();
  console.log(`Analyzing ${contests.length} completed contests...\n`);

  // Track wins per user
  const winsByUser = {};
  const contestsWithMultipleSuspects = [];

  for (const contest of contests) {
    const winners = contest.winners || (contest.winner ? [contest.winner] : []);
    const winnersLower = winners.map(w => w.toLowerCase());

    // Check which suspects won this contest
    const suspectWinners = [];
    for (const [username, data] of Object.entries(suspects)) {
      for (const wallet of data.wallets) {
        if (winnersLower.includes(wallet.toLowerCase())) {
          suspectWinners.push(username);
          winsByUser[username] = (winsByUser[username] || 0) + 1;
        }
      }
    }

    // If multiple suspects won the same contest
    if (suspectWinners.length > 1) {
      contestsWithMultipleSuspects.push({
        contestId: contest.contestId,
        type: contest.contractType,
        prize: `${contest.prizeAmount} ${contest.prizeTokenSymbol}`,
        winnerCount: contest.winnerCount,
        suspectWinners: [...new Set(suspectWinners)]
      });
    }
  }

  console.log('=== WINS BY USER ===\n');
  for (const [username, wins] of Object.entries(winsByUser).sort((a, b) => b[1] - a[1])) {
    console.log(`@${username}: ${wins} wins`);
  }

  console.log('\n=== CONTESTS WHERE MULTIPLE SUSPECTS WON TOGETHER ===\n');
  if (contestsWithMultipleSuspects.length > 0) {
    for (const c of contestsWithMultipleSuspects) {
      console.log(`Contest ${c.type}-${c.contestId}: ${c.prize}`);
      console.log(`  Winners from suspects: ${c.suspectWinners.join(', ')}`);
      console.log(`  Total winners: ${c.winnerCount}`);
    }
    console.log(`\n⚠️  ${contestsWithMultipleSuspects.length} contests had multiple suspects winning together!`);
  } else {
    console.log('No contests found where multiple suspects won together.');
  }
}

main();
