// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Namespaced storage shared by the fixed V2 shell and its fixed CoW module.
/// V1's storage layout remains at ordinary slots; neither implementation can be upgraded.
library StewardCowV2Storage {
    bytes32 internal constant SLOT = keccak256("steward.account.v2.cow.storage.2026-09-24");

    struct Pending {
        address actor;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 grossSell;
        uint256 periodStart;
        uint256 policyVersion;
        uint256 securityEpoch;
        uint32 validTo;
        bool isBuy;
        bool exception;
        uint8 state; // 0 absent, 1 pending, 2 filled, 3 cancelled, 4 expired/ambiguous charged
    }

    struct Layout {
        mapping(bytes32 => Pending) orders;
        mapping(address => uint256) reservedByToken;
        mapping(uint256 => uint256) buyReserved;
        mapping(uint256 => uint256) buySpent;
        mapping(address => mapping(uint256 => uint256)) sellReserved;
        mapping(address => mapping(uint256 => uint256)) sellSpent;
        mapping(address => mapping(uint256 => mapping(uint256 => bool))) usedNonce;
        uint8 activeCount;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly {
            l.slot := slot
        }
    }
}
