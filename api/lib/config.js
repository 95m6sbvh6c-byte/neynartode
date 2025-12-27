/**
 * Centralized configuration for all API endpoints
 * Eliminates duplicate CONFIG definitions across files
 */

const CONFIG = {
  // Contract Addresses
  NEYNARTODES: '0x8dE1622fE07f56cda2e2273e615A513F1d828B07',
  CONTEST_ESCROW: '0x0A8EAf7de19268ceF2d2bA4F9000c60680cAde7A',
  NFT_CONTEST_ESCROW: '0xFD6e84d4396Ecaa144771C65914b2a345305F922',

  // Uniswap V4 Pool
  V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  NEYNARTODES_POOL_ID: '0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7',

  // Chainlink
  CHAINLINK_ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',

  // Common tokens
  WETH: '0x4200000000000000000000000000000000000006',

  // RPC & API
  BASE_RPC: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
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

module.exports = {
  CONFIG,
  ABIS,
  CONTEST_STATUS,
  NFT_TYPE,
};
