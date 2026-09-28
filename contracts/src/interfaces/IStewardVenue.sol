// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IStewardVenue {
    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut);
}
