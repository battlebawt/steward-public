// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

contract MockPriceSource is IPriceSource {
    struct Value { uint256 value; uint8 decimals; uint256 updatedAt; bool paused; }
    mapping(address => Value) public values;
    mapping(address => address) public feed;

    function set(address asset, uint256 value, uint8 decimals_, uint256 updatedAt, bool paused) external {
        values[asset] = Value(value, decimals_, updatedAt, paused);
    }

    function setFeed(address asset, address feed_) external { feed[asset] = feed_; }
    function feedFor(address asset) external view returns (address) { return feed[asset]; }

    function price(address asset) external view returns (uint256, uint8, uint256, bool) {
        Value memory v = values[asset];
        return (v.value, v.decimals, v.updatedAt, v.paused);
    }
}
