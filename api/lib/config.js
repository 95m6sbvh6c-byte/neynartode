/**
 * Centralized configuration for all API endpoints
 * Eliminates duplicate CONFIG definitions across files
 */

const CONFIG = {
  // Contract Addresses
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',

  // NEW Unified ContestManager (M- and T- prefix contests)
  CONTEST_MANAGER: '0xF56Fe30e1eAb5178da1AA2CbBf14d1e3C0Ba3944',

  // LEGACY Contracts (archived - read-only for historical data)
  CONTEST_ESCROW_LEGACY: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW_LEGACY: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',
  CONTEST_MANAGER_V2_LEGACY: '0x91F7536E5Feafd7b1Ea0225611b02514B7c2eb06',

  // Uniswap V4 Pool
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',

  // Chainlink
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',

  // Common tokens
  WETH: '0x4200000000000000000000000000000000000006',

  // RPC & API
  BASE_RPC: process.env.BASE_RPC_URL || 'https://white-special-telescope.base-mainnet.quiknode.pro/f0dccf244a968a322545e7afab7957d927aceda3/',
  NEYNAR_API_KEY: process.env.NEYNAR_API_KEY || 'AA2E0FC2-FDC0-466D-9EBA-4BCA968C9B1D',

  // Chain
  CHAIN_ID: 8453,
  BLOCK_TIME_SECONDS: 2,

  // Limits
  MAX_QUOTE_CASTS: 100,
  MAX_REACTIONS_PER_PAGE: 100,
  API_RATE_LIMIT_MS: 100,
};

// Contract ABIs - centralized to avoid duplication
const ABIS = {
  // NEW Unified ContestManager ABI
  CONTEST_MANAGER: [
    // View functions
    'function getContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
    'function getTestContest(uint256 contestId) view returns (tuple(address host, uint8 prizeType, address prizeToken, uint256 prizeAmount, address nftContract, uint256 nftTokenId, uint256 nftAmount, uint256 startTime, uint256 endTime, string castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, uint8 winnerCount, address[] winners))',
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

  // LEGACY ABIs (for historical data)
  CONTEST_ESCROW: [
    'function getContest(uint256 _contestId) external view returns (address host, address prizeToken, uint256 prizeAmount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
    'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
    'function nextContestId() external view returns (uint256)',
    'function finalizeContest(uint256 _contestId, address[] calldata _qualifiedAddresses) external',
    'function cancelContest(uint256 _contestId, string calldata _reason) external',
  ],

  NFT_CONTEST_ESCROW: [
    'function getContest(uint256 _contestId) external view returns (address host, uint8 nftType, address nftContract, uint256 tokenId, uint256 amount, uint256 startTime, uint256 endTime, string memory castId, address tokenRequirement, uint256 volumeRequirement, uint8 status, address winner)',
    'function getQualifiedEntries(uint256 _contestId) external view returns (address[] memory)',
    'function nextContestId() external view returns (uint256)',
    'function finalizeContest(uint256 _contestId, address[] calldata _qualifiedAddresses) external',
    'function cancelContest(uint256 _contestId, string calldata _reason) external',
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
 * @param {string} contestIdStr - Contest ID like "M-1", "T-5", "v2-105", or "42"
 * @returns {{ id: number, type: 'main' | 'test' | 'v2-legacy' | 'v1-legacy', prefix: string }}
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
  if (str.startsWith('v2-')) {
    return { id: parseInt(str.slice(3)), type: 'v2-legacy', prefix: 'v2-' };
  }
  // Numeric only = V1 legacy
  const numId = parseInt(str);
  if (!isNaN(numId)) {
    return { id: numId, type: 'v1-legacy', prefix: '' };
  }

  return null;
}

/**
 * Check if a contest ID is from the new unified ContestManager
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
