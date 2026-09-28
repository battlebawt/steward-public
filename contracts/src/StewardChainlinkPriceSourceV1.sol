// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPriceSource} from "./interfaces/IPriceSource.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Chainlink-style source with explicit per-feed heartbeat and optional
/// L2 sequencer grace period. Settlement must have its own configured feed.
contract StewardChainlinkPriceSourceV1 is IPriceSource {
    struct Feed {
        address aggregator;
        uint64 maxAge;
        bool enabled;
    }
    mapping(address => Feed) public feeds;
    address public immutable sequencerFeed;
    uint64 public immutable sequencerGracePeriod;
    address public immutable owner;

    error InvalidFeed();
    error Unauthorized();

    constructor(address owner_, address sequencerFeed_, uint64 sequencerGracePeriod_, address[] memory assets, address[] memory aggregators, uint64[] memory maxAges) {
        // Some chains, including Robinhood Chain at this review, do not publish
        // a verified sequencer uptime feed. Zero explicitly selects the
        // feed-freshness/oracle-pause policy; a configured feed still enforces
        // its downtime and recovery-grace checks below.
        if (owner_ == address(0) || assets.length == 0 || assets.length != aggregators.length || assets.length != maxAges.length) revert InvalidFeed();
        if (sequencerFeed_ == address(0) && sequencerGracePeriod_ != 0) revert InvalidFeed();
        owner = owner_;
        sequencerFeed = sequencerFeed_;
        sequencerGracePeriod = sequencerGracePeriod_;
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] == address(0) || aggregators[i] == address(0) || maxAges[i] == 0) revert InvalidFeed();
            feeds[assets[i]] = Feed(aggregators[i], maxAges[i], true);
        }
    }

    function setFeed(address asset, address aggregator, uint64 maxAge, bool enabled) external {
        asset; aggregator; maxAge; enabled;
        // Feed identity is pinned at deployment. Replacing it requires a new
        // source/adapter manifest and an explicit account policy expansion.
        revert Unauthorized();
    }

    function feedFor(address asset) external view returns (address) {
        return feeds[asset].aggregator;
    }

    function price(address asset) external view returns (uint256 value, uint8 decimals, uint256 updatedAt, bool paused) {
        Feed memory f = feeds[asset];
        if (!f.enabled) return (0, 0, 0, true);
        (bool tokenCheck, bytes memory tokenData) = asset.staticcall(abi.encodeWithSignature("oraclePaused()"));
        if (tokenCheck && tokenData.length >= 32 && abi.decode(tokenData, (bool))) return (0, 0, 0, true);
        if (sequencerFeed != address(0)) {
            (, int256 answer, uint256 startedAt,,) = IAggregatorV3(sequencerFeed).latestRoundData();
            if (answer != 0 || startedAt == 0 || block.timestamp < startedAt || block.timestamp - startedAt <= sequencerGracePeriod) {
                return (0, 0, 0, true);
            }
        }
        (, int256 answer,, uint256 updated, uint80 answeredInRound) = IAggregatorV3(f.aggregator).latestRoundData();
        (uint80 roundId,,,,) = IAggregatorV3(f.aggregator).latestRoundData();
        if (answer <= 0 || updated == 0 || updated > block.timestamp || block.timestamp - updated > f.maxAge || answeredInRound < roundId) {
            return (0, 0, 0, true);
        }
        return (uint256(answer), IAggregatorV3(f.aggregator).decimals(), updated, false);
    }
}
