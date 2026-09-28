// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStewardVenue} from "../interfaces/IStewardVenue.sol";

contract MockStewardVenue is IStewardVenue {
    using SafeERC20 for IERC20;
    mapping(address => mapping(address => uint256)) public rate; // output raw per input raw, scaled 1e18
    bool public reenter;
    address public reenterTarget;

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external { rate[tokenIn][tokenOut] = rate_; }
    function setReenter(address target, bool value) external { reenterTarget = target; reenter = value; }

    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn * rate[tokenIn][tokenOut] / 1e18;
        if (amountOut < minAmountOut) revert();
        if (reenter && reenterTarget != address(0)) reenterTarget.call(abi.encodeWithSignature("unpauseDelegatedSpending()"));
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }
}
