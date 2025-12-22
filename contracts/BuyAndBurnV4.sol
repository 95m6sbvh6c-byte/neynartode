// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BuyAndBurnV4
 * @notice Buys exactly 10,000 NEYNARTODES tokens from V4 pool and burns them
 * @dev Uses Uniswap V4 PoolManager on Base with specific NEYNARTODES/ETH pool
 *
 * Pool ID: 0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7
 *
 * How it works:
 * 1. User sends ETH with their transaction
 * 2. Contract swaps ETH for exactly 10,000 NEYNARTODES via specific V4 pool
 * 3. Tokens are sent to burn address (0xdead)
 * 4. Excess ETH is refunded to user
 *
 * DEPLOYMENT NOTES:
 * - Deploy to Base mainnet
 * - No initialization required
 * - Test with small amount first
 */

// ============ V4 Interfaces ============

/// @notice Minimal interface for Uniswap V4 PoolManager
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function swap(
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (int256 amount0, int256 amount1);
}

/// @notice V4 Universal Router for easier swaps
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract BuyAndBurnV4 {
    // ============ Constants ============

    /// @notice NEYNARTODES token address on Base
    address public constant NEYNARTODES = 0x8de1622fe07f56CDA2E2273e615a513f1D828b07;

    /// @notice Native ETH represented as address(0) in V4
    address public constant NATIVE_ETH = address(0);

    /// @notice WETH address on Base
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice Uniswap V4 PoolManager on Base
    address public constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    /// @notice Universal Router on Base (for V4 swaps)
    address public constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    /// @notice Burn address
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Amount of tokens to buy and burn (10,000 with 18 decimals)
    uint256 public constant BURN_AMOUNT = 10_000 * 1e18;

    /// @notice The specific V4 pool ID for NEYNARTODES/ETH
    /// @dev This is the keccak256 hash of the PoolKey
    bytes32 public constant POOL_ID = 0xfad8f807f3f300d594c5725adb8f54314d465bcb1ab8cc04e37b08c1aa80d2e7;

    // ============ Pool Key Components ============
    // These define the specific pool to use (must match POOL_ID when hashed)
    // You'll need to fill these in based on the actual pool configuration

    /// @dev Pool fee in hundredths of a bip (e.g., 3000 = 0.3%)
    uint24 public constant POOL_FEE = 10000; // Adjust based on actual pool

    /// @dev Tick spacing for the pool
    int24 public constant TICK_SPACING = 200; // Adjust based on actual pool

    /// @dev Hooks contract address (address(0) if no hooks)
    address public constant HOOKS = address(0); // Adjust if pool uses hooks

    // ============ Events ============

    event BurnExecuted(
        address indexed user,
        uint256 tokensBurned,
        uint256 ethSpent,
        uint256 timestamp
    );

    // ============ Main Function ============

    /**
     * @notice Buy exactly 10,000 NEYNARTODES and burn them
     * @dev Swaps ETH for tokens via Uniswap V4 specific pool, burns tokens, refunds excess
     *
     * IMPORTANT: User must send enough ETH to cover the swap + gas
     * Recommended: Send 0.005 ETH (excess will be refunded)
     */
    function buyAndBurn() external payable {
        require(msg.value > 0, "Must send ETH");

        uint256 startBalance = address(this).balance;

        // Build the swap command for Universal Router
        // Command 0x00 = V4_SWAP
        bytes memory commands = hex"00";

        // Build pool key struct for the swap
        IPoolManager.PoolKey memory poolKey = IPoolManager.PoolKey({
            currency0: NATIVE_ETH,      // ETH (currency0 should be < currency1)
            currency1: NEYNARTODES,     // NEYNARTODES token
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: HOOKS
        });

        // Encode swap input - exactOutput of BURN_AMOUNT tokens
        // zeroForOne = true (ETH -> NEYNARTODES since ETH is currency0)
        bytes memory swapInput = abi.encode(
            poolKey,
            true,                       // zeroForOne
            -int256(BURN_AMOUNT),       // negative = exactOutput
            0,                          // sqrtPriceLimitX96 (0 = no limit)
            BURN_ADDRESS                // recipient
        );

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = swapInput;

        // Execute swap through Universal Router
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: msg.value}(
            commands,
            inputs,
            block.timestamp + 300       // 5 minute deadline
        );

        // Calculate how much ETH was spent
        uint256 ethSpent = startBalance + msg.value - address(this).balance;

        // Refund any excess ETH
        uint256 excess = address(this).balance;
        if (excess > 0) {
            (bool success, ) = msg.sender.call{value: excess}("");
            require(success, "ETH refund failed");
        }

        emit BurnExecuted(msg.sender, BURN_AMOUNT, ethSpent, block.timestamp);
    }

    /**
     * @notice Alternative simple implementation using direct token transfer
     * @dev This is a simpler approach if V4 routing is complex
     *      Caller swaps externally, this just burns tokens
     */
    function burnTokens() external {
        uint256 balance = IERC20(NEYNARTODES).balanceOf(address(this));
        require(balance > 0, "No tokens to burn");
        IERC20(NEYNARTODES).transfer(BURN_ADDRESS, balance);
        emit BurnExecuted(msg.sender, balance, 0, block.timestamp);
    }

    // ============ View Functions ============

    /**
     * @notice Get the pool ID this contract uses
     */
    function getPoolId() external pure returns (bytes32) {
        return POOL_ID;
    }

    // ============ Receive ETH ============

    receive() external payable {}

    // ============ Emergency Functions ============

    /// @notice Rescue any stuck tokens
    function rescueTokens(address token, uint256 amount) external {
        // TODO: Add onlyOwner in production
        IERC20(token).transfer(msg.sender, amount);
    }

    /// @notice Rescue any stuck ETH
    function rescueETH() external {
        // TODO: Add onlyOwner in production
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "ETH rescue failed");
    }
}
