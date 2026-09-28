// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";

contract StewardAccountHandler is Test {
    StewardAccountV1 public immutable account;
    MockStewardToken public immutable settlement;
    address public immutable parent;
    address public immutable guardian1;
    address public immutable guardian2;
    address public immutable delegate1;
    address public immutable delegate2;
    uint256 public immutable delegate1Key;
    uint256 public immutable delegate2Key;

    uint256 public nonceCursor = 1;
    bytes32 public lastActionId;
    address public lastActor;
    uint256 public lastEpoch;
    uint256 public lastNonce;
    uint256 public successfulPayments;
    bool public revoked1;
    bool public revoked2;

    constructor(
        StewardAccountV1 account_,
        MockStewardToken settlement_,
        address parent_,
        address guardian1_,
        address guardian2_,
        address delegate1_,
        address delegate2_,
        uint256 delegate1Key_,
        uint256 delegate2Key_
    ) {
        account = account_;
        settlement = settlement_;
        parent = parent_;
        guardian1 = guardian1_;
        guardian2 = guardian2_;
        delegate1 = delegate1_;
        delegate2 = delegate2_;
        delegate1Key = delegate1Key_;
        delegate2Key = delegate2Key_;
    }

    /// @dev Bounded payment driver. Some calls deliberately reuse the last
    /// exact action to exercise nonce and action-id replay rejection.
    function pay(uint96 rawAmount, uint8 delegateIndex, bool replay) external {
        address actor = delegateIndex % 2 == 0 ? delegate1 : delegate2;
        uint256 key = delegateIndex % 2 == 0 ? delegate1Key : delegate2Key;
        uint256 nonce = replay && lastActionId != bytes32(0) && actor == lastActor ? lastNonce : nonceCursor++;
        uint256 version;
        (,,,,,,,,,, version) = account.policy();
        StewardAccountV1.Action memory a = StewardAccountV1.Action({
            actionId: replay && lastActionId != bytes32(0) && actor == lastActor
                ? lastActionId
                : keccak256(abi.encode(actor, nonce, successfulPayments)),
            kind: 0,
            account: address(account),
            actor: actor,
            chainId: block.chainid,
            securityEpoch: account.securityEpoch(),
            policyVersion: version,
            nonce: nonce,
            tokenIn: address(settlement),
            tokenOut: address(0),
            recipient: account.parent(),
            amountInRaw: bound(rawAmount, 1, 100e6),
            minAmountOutRaw: 0,
            adapter: address(0),
            routeHash: bytes32(0),
            validAfter: uint64(block.timestamp - 1),
            deadline: uint64(block.timestamp + 1 days),
            exceptionMask: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, account.actionHash(a));
        bytes[] memory approvals = new bytes[](1);
        approvals[0] = abi.encodePacked(r, s, v);
        try account.executePayment(a, approvals) returns (uint256) {
            lastActionId = a.actionId;
            lastActor = actor;
            lastEpoch = a.securityEpoch;
            lastNonce = a.nonce;
            ++successfulPayments;
        } catch {}
    }

    function revoke(uint8 delegateIndex) external {
        if (account.parent() != parent) return;
        address target = delegateIndex % 2 == 0 ? delegate1 : delegate2;
        vm.prank(parent);
        account.revokeDelegate(target);
        if (delegateIndex % 2 == 0) revoked1 = true;
        else revoked2 = true;
    }

    function rotateEpoch() external {
        if (account.securityEpoch() != 1 || account.recoveryNonce() != 0) return;
        vm.prank(guardian1);
        account.startRecovery(address(0xBEEF));
        uint256 id = account.recoveryNonce();
        vm.prank(guardian2);
        account.approveRecovery(id);
        vm.warp(block.timestamp + 48 hours + 1);
        account.executeRecovery();
    }
}

contract StewardAccountInvariantTest is Test {
    StewardAccountV1 internal account;
    MockStewardToken internal settlement;
    StewardAccountHandler internal handler;
    address internal parent;
    address internal guardian1;
    address internal guardian2;
    address internal delegate1;
    address internal delegate2;
    uint256 internal delegate1Key = 0xD1;
    uint256 internal delegate2Key = 0xD2;

    function setUp() public {
        parent = vm.addr(0xA1);
        guardian1 = vm.addr(0xA2);
        guardian2 = vm.addr(0xA3);
        delegate1 = vm.addr(delegate1Key);
        delegate2 = vm.addr(delegate2Key);
        settlement = new MockStewardToken("Settlement", "USDG", 6);
        address[] memory empty = new address[](0);
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = vm.addr(0xA4);
        address[] memory exceptions = new address[](1);
        exceptions[0] = vm.addr(0xA5);
        StewardAccountV1.PolicyConfig memory c = StewardAccountV1.PolicyConfig({
            settlement: address(settlement), period: 1 days, anchor: 0, paymentLimit: 1_000e6, buyLimit: 1_000e6,
            reserve: 0, perPayment: 100e6, perBuy: 100e6, perSell: 100e18, exceptionQuorum: 1,
            approvedTokens: empty, paymentRecipients: new address[](1), exceptionSigners: exceptions, guardians: guardians,
            approvedAdapters: empty, sellCapTokens: empty, sellCaps: new uint256[](0), continuityReviewer: address(0),
            continuitySuccessor: address(0), continuityPlanHash: bytes32(0)
        });
        c.paymentRecipients[0] = parent;
        account = new StewardAccountV1();
        account.initialize(parent, c);
        settlement.mint(address(account), 1_000_000e6);

        vm.prank(parent);
        account.setDelegate(delegate1, 1, uint64(block.timestamp + 30 days), 100e6);
        vm.prank(parent);
        account.setDelegate(delegate2, 1, uint64(block.timestamp + 30 days), 100e6);

        handler = new StewardAccountHandler(account, settlement, parent, guardian1, guardian2, delegate1, delegate2, delegate1Key, delegate2Key);
        targetContract(address(handler));
    }

    function invariant_accountPaymentCapAndReplayState() public view {
        StewardAccountV1.PolicyConfig memory c = _policyConfiguration();
        assertLe(account.paymentSpent(address(settlement), account.periodStart()), c.paymentLimit);
        if (handler.lastActionId() != bytes32(0)) {
            assertTrue(account.executedAction(handler.lastActionId()));
            assertTrue(account.usedNonce(handler.lastActor(), handler.lastEpoch(), handler.lastNonce()));
        }
    }

    function invariant_revocationAndEpochRemainBound() public view {
        if (handler.revoked1()) {
            (,,,, bool enabled) = account.delegates(handler.delegate1());
            assertFalse(enabled);
        }
        if (handler.revoked2()) {
            (,,,, bool enabled) = account.delegates(handler.delegate2());
            assertFalse(enabled);
        }
        assertGe(account.securityEpoch(), 1);
    }

    /// @dev Reconstruct the pre-existing aggregate shape from the granular
    /// read views. This keeps the invariant independent of a production-only
    /// aggregate getter that would duplicate policy state and bytecode.
    function _policyConfiguration() internal view returns (StewardAccountV1.PolicyConfig memory c) {
        address[] memory approvedTokens = account.policyAddresses(0);
        address[] memory paymentRecipients = account.policyAddresses(1);
        address[] memory exceptionSigners = account.policyAddresses(2);
        address[] memory guardians = account.policyAddresses(3);
        address[] memory approvedAdapters = account.policyAddresses(4);
        address[] memory sellCapTokens = account.policyAddresses(5);
        uint256[] memory sellCaps = new uint256[](sellCapTokens.length);
        for (uint256 i; i < sellCapTokens.length; ++i) sellCaps[i] = account.sellLimit(sellCapTokens[i]);

        (
            address settlement_, uint64 period_, uint64 anchor_, uint256 paymentLimit_, uint256 buyLimit_,
            uint256 reserve_, uint256 perPayment_, uint256 perBuy_, uint256 perSell_, uint256 exceptionQuorum_, uint256 version_
        ) = account.policy();
        version_;
        c = StewardAccountV1.PolicyConfig({
            settlement: settlement_, period: period_, anchor: anchor_, paymentLimit: paymentLimit_, buyLimit: buyLimit_,
            reserve: reserve_, perPayment: perPayment_, perBuy: perBuy_, perSell: perSell_,
            exceptionQuorum: exceptionQuorum_, approvedTokens: approvedTokens, paymentRecipients: paymentRecipients,
            exceptionSigners: exceptionSigners, guardians: guardians, approvedAdapters: approvedAdapters,
            sellCapTokens: sellCapTokens, sellCaps: sellCaps, continuityReviewer: account.continuityReviewer(),
            continuitySuccessor: account.continuitySuccessor(), continuityPlanHash: account.continuityPlanHash()
        });
    }
}
