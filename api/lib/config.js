/**
 * Centralized configuration for all API endpoints
 * Unified ContestManager only - legacy contracts removed
 */

const CONFIG = {
  // Contract Addresses
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',

  // Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',

  // Uniswap V4 Pool
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',

  // Chainlink
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',

  // Common tokens
  WETH: '0x4200000000000000000000000000000000000006',

  // RPC & API
  BASE_RPC: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/QooWtq9nKQlkeqKF_-rvC',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',

  // Chain
  CHAIN_ID: 8453,
  BLOCK_TIME_SECONDS: 2,

  // Limits
  MAX_QUOTE_CASTS: 100,
  MAX_REACTIONS_PER_PAGE: 100,
  API_RATE_LIMIT_MS: 100,
};

// Contract ABIs
const ABIS = {
  // Unified ContestManager ABI
  // Struct order: host, contestType, status, castId, startTime, endTime, prizeToken, prizeAmount, nftAmount, tokenRequirement, volumeRequirement, winnerCount, winners, isTestContest
  CONTEST_MANAGER: [
    // View functions - use getContestFull/getTestContestFull for full struct data
    'function getContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
    'function getTestContestFull(uint256 contestId) view returns (tuple(address host, uint8 contestType, uint8 status, string castId, uint256 startTime, uint256 endTime, address prizeToken, uint256 prizeAmount, uint256 nftAmount, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount, address[] winners, bool isTestContest))',
    'function mainNextContestId() view returns (uint256)',
    'function testNextContestId() view returns (uint256)',
    'function getPendingDeposit(uint256 depositId) view returns (tuple(address depositor, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, bool used))',
    'function nftToDepositId(address nftContract, uint256 tokenId) view returns (uint256)',
    'function canFinalize(uint256 contestId) view returns (bool)',
    'function canFinalizeTest(uint256 contestId) view returns (bool)',
    'function minPrizeValueWei() view returns (uint256)',
    // Main contest creation
    'function createContestETH(uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount) payable returns (uint256)',
    'function createContestERC20(address prizeToken, uint256 prizeAmount, uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount) payable returns (uint256)',
    'function registerContest(uint256 depositId, uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement) payable returns (uint256)',
    // Test contest creation
    'function createTestContestETH(uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount) payable returns (uint256)',
    'function createTestContestERC20(address prizeToken, uint256 prizeAmount, uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement, uint8 winnerCount) payable returns (uint256)',
    'function registerTestContest(uint256 depositId, uint256 duration, string calldata castId, address tokenRequirement, uint256 volumeRequirement) payable returns (uint256)',
    // Finalization
    'function finalizeContest(uint256 contestId, address[] calldata qualifiedAddresses) external',
    'function finalizeTestContest(uint256 contestId, address[] calldata qualifiedAddresses) external',
    // NFT deposit management
    'function withdrawDeposit(uint256 depositId) external',
    // Admin
    'function setMinPrizeValue(uint256 _minPrizeValueWei) external',
    // Events
    'event ContestCreated(uint256 indexed contestId, address indexed host, uint8 prizeType, bool isTest)',
    'event ContestFinalized(uint256 indexed contestId, address[] winners, bool isTest)',
    'event NFTDeposited(uint256 indexed depositId, address indexed depositor, address nftContract, uint256 tokenId)',
    'event MinPrizeValueUpdated(uint256 oldValue, uint256 newValue)',
  ],

  ERC20: [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function name() view returns (string)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ],

  ERC721: [
    'function name() view returns (string)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function approve(address to, uint256 tokenId)',
    'function getApproved(uint256 tokenId) view returns (address)',
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function safeTransferFrom(address from, address to, uint256 tokenId)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  ],

  ERC1155: [
    'function uri(uint256 id) view returns (string)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  ],

  V4_STATE_VIEW: [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ],

  CHAINLINK: [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  ],

  V2_FACTORY: ['function getPair(address, address) view returns (address)'],
  V2_PAIR: [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
  ],

  V3_FACTORY: ['function getPool(address, address, uint24) view returns (address)'],
  V3_POOL: [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
  ],
};

// Contest status enum
const CONTEST_STATUS = {
  ACTIVE: 0,
  PENDING_VRF: 1,
  COMPLETED: 2,
  CANCELLED: 3,
};

// NFT types
const NFT_TYPE = {
  ERC721: 0,
  ERC1155: 1,
};

// Prize types (matches Solidity enum)
const PRIZE_TYPE = {
  ETH: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
};

/**
 * Parse a contest ID string to determine its type and numeric ID
 * @param {string} contestIdStr - Contest ID like "M-1", "T-5"
 * @returns {{ id: number, type: 'main' | 'test', prefix: string }}
 */
function parseContestId(contestIdStr) {
  if (!contestIdStr) return null;

  const str = String(contestIdStr);

  if (str.startsWith('M-')) {
    return { id: parseInt(str.slice(2)), type: 'main', prefix: 'M-' };
  }
  if (str.startsWith('T-')) {
    return { id: parseInt(str.slice(2)), type: 'test', prefix: 'T-' };
  }

  // Default to main if just a number
  const numId = parseInt(str);
  if (!isNaN(numId)) {
    return { id: numId, type: 'main', prefix: 'M-' };
  }

  return null;
}

/**
 * Check if a contest ID is from the unified ContestManager
 * @param {string} contestIdStr - Contest ID string
 * @returns {boolean}
 */
function isUnifiedContest(contestIdStr) {
  const parsed = parseContestId(contestIdStr);
  return parsed && (parsed.type === 'main' || parsed.type === 'test');
}

module.exports = {
  CONFIG,
  ABIS,
  CONTEST_STATUS,
  NFT_TYPE,
  PRIZE_TYPE,
  parseContestId,
  isUnifiedContest,
};
