// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStewardTradeAdapter} from "./interfaces/IStewardTradeAdapter.sol";
import {IStewardVenue} from "./interfaces/IStewardVenue.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @notice Immutable, exact-input trade adapter. It supports only routes pinned
/// at construction and sends output to the calling Steward account.
contract StewardTradeAdapterV1 is IStewardTradeAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        bytes32 id;
        address priceIn;
        address priceOut;
        bool enabled;
    }

    address public immutable settlement;
    address public immutable venue;
    IPriceSource public immutable source;
    uint256 public immutable maxPriceAge;
    uint256 public immutable slippageBps;
    mapping(bytes32 => Route) public routes;
    mapping(address => mapping(address => bytes32)) public routeFor;

    error BadRoute();
    error BadPrice();
    error StalePrice();
    error Unsupported();
    error Slippage();
    error Recipient();
    error CallerMustBeAccount();

    constructor(
        address settlement_,
        address venue_,
        address source_,
        uint256 maxPriceAge_,
        uint256 slippageBps_,
        address[] memory tokens,
        address[] memory priceFeeds
    ) {
        if (settlement_ == address(0) || venue_ == address(0) || source_ == address(0)) revert BadRoute();
        if (tokens.length != priceFeeds.length || tokens.length == 0 || slippageBps_ >= 10_000 || slippageBps_ > 5_000 || maxPriceAge_ == 0) revert BadRoute();
        if (IPriceSource(source_).feedFor(settlement_) == address(0)) revert BadRoute();
        settlement = settlement_;
        venue = venue_;
        source = IPriceSource(source_);
        maxPriceAge = maxPriceAge_;
        slippageBps = slippageBps_;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0) || tokens[i] == settlement_ || priceFeeds[i] == address(0)) revert BadRoute();
            if (IPriceSource(source_).feedFor(tokens[i]) != priceFeeds[i]) revert BadRoute();
            _addRoute(settlement_, tokens[i], IPriceSource(source_).feedFor(settlement_), priceFeeds[i]);
            _addRoute(tokens[i], settlement_, priceFeeds[i], IPriceSource(source_).feedFor(settlement_));
        }
    }

    function _addRoute(address tokenIn, address tokenOut, address priceIn, address priceOut) internal {
        bytes32 id = keccak256(abi.encode(address(this), tokenIn, tokenOut, priceIn, priceOut));
        routes[id] = Route(id, priceIn, priceOut, true);
        routeFor[tokenIn][tokenOut] = id;
    }

    function routeHash(address tokenIn, address tokenOut) external view returns (bytes32) {
        return routeFor[tokenIn][tokenOut];
    }

    function _price(address asset, address feed) internal view returns (uint256 value, uint8 decimals) {
        bool paused;
        uint256 updatedAt;
        if (source.feedFor(asset) != feed) revert BadPrice();
        (value, decimals, updatedAt, paused) = source.price(asset);
        if (paused || value == 0 || decimals > 36) revert BadPrice();
        if (updatedAt == 0 || updatedAt > block.timestamp) revert BadPrice();
        if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
    }

    function _quote(Route memory r, address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        if (amountIn == 0 || !r.enabled) revert BadRoute();
        (uint256 inPrice, uint8 inDecimals) = _price(tokenIn, r.priceIn);
        (uint256 outPrice, uint8 outDecimals) = _price(tokenOut, r.priceOut);
        // Adapter prices are normalized by the source. Token decimals are read
        // through the standard ERC20 metadata interface by a low-level call.
        (bool okIn, bytes memory inData) = tokenIn.staticcall(abi.encodeWithSignature("decimals()"));
        (bool okOut, bytes memory outData) = tokenOut.staticcall(abi.encodeWithSignature("decimals()"));
        if (!okIn || !okOut || inData.length < 32 || outData.length < 32) revert Unsupported();
        uint8 inTokenDecimals = abi.decode(inData, (uint8));
        uint8 outTokenDecimals = abi.decode(outData, (uint8));
        if (inTokenDecimals > 18 || outTokenDecimals > 18 || inDecimals > 18 || outDecimals > 18) revert Unsupported();
        uint256 normalized = Math.mulDiv(amountIn, inPrice, outPrice);
        normalized = Math.mulDiv(normalized, 10 ** uint256(outTokenDecimals), 10 ** uint256(inTokenDecimals));
        return Math.mulDiv(normalized, 10 ** uint256(outDecimals), 10 ** uint256(inDecimals));
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == tokenOut || (tokenIn != settlement && tokenOut != settlement)) revert Unsupported();
        bytes32 id = routeFor[tokenIn][tokenOut];
        if (id == bytes32(0)) revert Unsupported();
        return _quote(routes[id], tokenIn, tokenOut, amountIn);
    }

    function independentFloor(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        uint256 expected = quote(tokenIn, tokenOut, amountIn);
        return expected * (10_000 - slippageBps) / 10_000;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes32 routeHash_
    ) external nonReentrant returns (uint256 amountOut) {
        if (recipient == address(0) || recipient != msg.sender) revert Recipient();
        if (routeFor[tokenIn][tokenOut] != routeHash_ || routeHash_ == bytes32(0)) revert BadRoute();
        uint256 floor = this.independentFloor(tokenIn, tokenOut, amountIn);
        if (minAmountOut < floor) revert Slippage();
        IERC20 input = IERC20(tokenIn);
        IERC20 output = IERC20(tokenOut);
        uint256 beforeBalance = output.balanceOf(recipient);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        input.forceApprove(venue, amountIn);
        IStewardVenue(venue).swapExactInput(tokenIn, tokenOut, amountIn, minAmountOut, recipient);
        input.forceApprove(venue, 0);
        amountOut = output.balanceOf(recipient) - beforeBalance;
        if (amountOut < minAmountOut) revert Slippage();
    }
}
