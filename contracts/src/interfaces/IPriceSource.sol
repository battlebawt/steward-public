// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPriceSource {
    function feedFor(address asset) external view returns (address);
    function price(address asset) external view returns (uint256 value, uint8 decimals, uint256 updatedAt, bool paused);
}
