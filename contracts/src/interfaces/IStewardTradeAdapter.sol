// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IStewardTradeAdapter {
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
    function independentFloor(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes32 routeHash
    ) external returns (uint256 amountOut);
    function routeHash(address tokenIn, address tokenOut) external view returns (bytes32);
}
