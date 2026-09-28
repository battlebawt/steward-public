// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardTradeAdapterV1} from "../src/StewardTradeAdapterV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockStewardVenue} from "../src/mocks/MockStewardVenue.sol";

contract StewardTradeAdapterTest is Test {
    MockStewardToken internal settlement;
    MockStewardToken internal stock;
    MockPriceSource internal source;
    MockStewardVenue internal venue;
    StewardTradeAdapterV1 internal adapter;
    address internal trader = address(0xCAFE);

    function setUp() public {
        vm.warp(1 days);
        settlement = new MockStewardToken("Settlement", "USDG", 6);
        stock = new MockStewardToken("Stock", "STK", 18);
        source = new MockPriceSource();
        venue = new MockStewardVenue();
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        address[] memory feeds = new address[](1);
        feeds[0] = address(0xFEE1);
        source.setFeed(address(settlement), address(0xFEE0));
        source.setFeed(address(stock), feeds[0]);
        adapter = new StewardTradeAdapterV1(address(settlement), address(venue), address(source), 1 hours, 500, tokens, feeds);
        source.set(address(settlement), 1e8, 8, block.timestamp, false);
        source.set(address(stock), 5e7, 8, block.timestamp, false);
        venue.setRate(address(settlement), address(stock), 2e30); // 1 settlement raw -> 2 stock raw after decimals
        settlement.mint(trader, 100e6);
        stock.mint(address(venue), 1_000e18);
        vm.prank(trader);
        settlement.approve(address(adapter), type(uint256).max);
    }

    function testIndependentFloorAndMeasuredOutput() public {
        bytes32 route = adapter.routeHash(address(settlement), address(stock));
        uint256 floor = adapter.independentFloor(address(settlement), address(stock), 1e6);
        assertEq(floor, 1.9e18);
        vm.prank(trader);
        uint256 out = adapter.swap(address(settlement), address(stock), 1e6, floor, trader, route);
        assertEq(out, 2e18);
        assertEq(settlement.allowance(address(adapter), address(venue)), 0);
    }

    function testStaleAndPausedSourceFailClosed() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(trader);
        vm.expectRevert(StewardTradeAdapterV1.StalePrice.selector);
        adapter.independentFloor(address(settlement), address(stock), 1e6);
        source.set(address(settlement), 1e8, 8, block.timestamp, true);
        vm.expectRevert(StewardTradeAdapterV1.BadPrice.selector);
        adapter.independentFloor(address(settlement), address(stock), 1e6);
    }

    function testSettlementDepegChangesIndependentFloor() public {
        source.set(address(settlement), 8e7, 8, block.timestamp, false);
        uint256 floor = adapter.independentFloor(address(settlement), address(stock), 1e6);
        assertEq(floor, 1.52e18);
    }
}
