// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStewardVenue} from "./interfaces/IStewardVenue.sol";

interface IStewardSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/// @notice Narrow single-hop Uniswap V3 venue. Route fees and the only caller
/// (the reviewed StewardTradeAdapter) are explicit; arbitrary router calldata
/// cannot enter this contract.
contract StewardUniswapV3VenueV1 is IStewardVenue {
    using SafeERC20 for IERC20;
    address public immutable router;
    address public immutable owner;
    mapping(address => bool) public approvedCaller;
    mapping(address => mapping(address => uint24)) public feeFor;

    error Unauthorized();
    error Unsupported();

    constructor(address owner_, address router_) {
        if (owner_ == address(0) || router_ == address(0)) revert Unsupported();
        owner = owner_;
        router = router_;
    }

    function setCaller(address caller, bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        approvedCaller[caller] = enabled;
    }

    function setRoute(address tokenIn, address tokenOut, uint24 fee) external {
        if (msg.sender != owner || tokenIn == address(0) || tokenOut == address(0) || fee == 0) revert Unauthorized();
        feeFor[tokenIn][tokenOut] = fee;
    }

    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        uint24 fee = feeFor[tokenIn][tokenOut];
        if (!approvedCaller[msg.sender] || fee == 0 || recipient == address(0) || amountIn == 0) revert Unsupported();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(router, amountIn);
        amountOut = IStewardSwapRouter(router).exactInputSingle(
            IStewardSwapRouter.ExactInputSingleParams(tokenIn, tokenOut, fee, recipient, amountIn, minAmountOut, 0)
        );
        IERC20(tokenIn).forceApprove(router, 0);
    }
}
