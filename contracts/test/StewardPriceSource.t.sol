// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardChainlinkPriceSourceV1} from "../src/StewardChainlinkPriceSourceV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";

contract MockAggregatorV3 {
    uint8 public immutable decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    constructor(uint8 decimals_, int256 answer_, uint256 startedAt_, uint256 updatedAt_) {
        decimals = decimals_;
        set(answer_, startedAt_, updatedAt_);
    }

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) public {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract StewardPriceSourceTest is Test {
    function testNoPublishedSequencerFeedStillRejectsStaleAndPausedPrices() public {
        vm.warp(100 days);
        MockStewardToken settlement = new MockStewardToken("Settlement", "USDG", 6);
        MockStewardToken stock = new MockStewardToken("Stock", "STK", 18);
        MockAggregatorV3 settlementFeed = new MockAggregatorV3(8, 100_000_000, block.timestamp, block.timestamp);
        MockAggregatorV3 stockFeed = new MockAggregatorV3(8, 50_000_000, block.timestamp, block.timestamp);
        address[] memory assets = new address[](2);
        assets[0] = address(settlement);
        assets[1] = address(stock);
        address[] memory feeds = new address[](2);
        feeds[0] = address(settlementFeed);
        feeds[1] = address(stockFeed);
        uint64[] memory ages = new uint64[](2);
        ages[0] = 1 hours;
        ages[1] = 1 hours;
        StewardChainlinkPriceSourceV1 source = new StewardChainlinkPriceSourceV1(address(this), address(0), 0, assets, feeds, ages);
        (uint256 price,,, bool paused) = source.price(address(stock));
        assertEq(price, 50_000_000);
        assertFalse(paused);
        stock.setOraclePaused(true);
        (,,, paused) = source.price(address(stock));
        assertTrue(paused);
        stock.setOraclePaused(false);
        vm.warp(block.timestamp + 1 hours + 1);
        (,,, paused) = source.price(address(stock));
        assertTrue(paused);
        (,,, paused) = source.price(address(settlement));
        assertTrue(paused);
    }

    function testSequencerGracePauseTokenPauseAndFreshness() public {
        vm.warp(100 days);
        MockStewardToken settlement = new MockStewardToken("Settlement", "USDG", 6);
        MockStewardToken stock = new MockStewardToken("Stock", "STK", 18);
        MockAggregatorV3 sequencer = new MockAggregatorV3(0, 0, block.timestamp - 1 days, block.timestamp - 1 days);
        MockAggregatorV3 settlementFeed = new MockAggregatorV3(8, 80_000_000, block.timestamp - 1 days, block.timestamp);
        MockAggregatorV3 stockFeed = new MockAggregatorV3(8, 50_000_000, block.timestamp - 1 days, block.timestamp);
        address[] memory assets = new address[](2);
        assets[0] = address(settlement);
        assets[1] = address(stock);
        address[] memory feeds = new address[](2);
        feeds[0] = address(settlementFeed);
        feeds[1] = address(stockFeed);
        uint64[] memory ages = new uint64[](2);
        ages[0] = 1 hours;
        ages[1] = 1 hours;
        StewardChainlinkPriceSourceV1 source = new StewardChainlinkPriceSourceV1(
            address(this), address(sequencer), 1 hours, assets, feeds, ages
        );
        (uint256 settlementPrice,,, bool paused) = source.price(address(settlement));
        assertEq(settlementPrice, 80_000_000);
        assertFalse(paused);
        // Sequencer recovery grace period is fail-closed.
        sequencer.set(0, block.timestamp - 10 minutes, block.timestamp - 10 minutes);
        (,,, paused) = source.price(address(settlement));
        assertTrue(paused);
        sequencer.set(0, block.timestamp - 2 hours, block.timestamp - 2 hours);
        stock.setOraclePaused(true);
        (,,, paused) = source.price(address(stock));
        assertTrue(paused);
        stock.setOraclePaused(false);
        settlementFeed.set(80_000_000, block.timestamp - 2 days, block.timestamp - 2 days);
        (,,, paused) = source.price(address(settlement));
        assertTrue(paused);
    }
}
