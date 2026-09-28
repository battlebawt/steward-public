// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {StewardFactoryV1} from "../src/StewardFactoryV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";

contract StewardAccountTest is Test {
    uint256 internal parentKey = 0xA11CE;
    uint256 internal delegateKey = 0xB0B;
    uint256 internal guardian1Key = 0xC01;
    uint256 internal guardian2Key = 0xC02;
    uint256 internal guardian3Key = 0xC03;
    uint256 internal exception1Key = 0xE01;
    uint256 internal exception2Key = 0xE02;
    address internal parent;
    address internal delegate;
    address internal recipient = address(0xD00D);
    address internal guardian1;
    address internal guardian2;
    address internal guardian3;
    address internal exception1;
    address internal exception2;
    MockStewardToken internal settlement;
    address internal stock;
    StewardAccountV1 internal account;

    function setUp() public {
        parent = vm.addr(parentKey);
        delegate = vm.addr(delegateKey);
        guardian1 = vm.addr(guardian1Key);
        guardian2 = vm.addr(guardian2Key);
        guardian3 = vm.addr(guardian3Key);
        exception1 = vm.addr(exception1Key);
        exception2 = vm.addr(exception2Key);
        settlement = new MockStewardToken("Settlement", "USDG", 6);
        address[] memory assets = new address[](1);
        assets[0] = address(new MockStewardToken("Stock", "STK", 18));
        stock = assets[0];
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        address[] memory exceptions = new address[](2);
        exceptions[0] = exception1;
        exceptions[1] = exception2;
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;
        address[] memory adapters = new address[](0);
        address[] memory sellCapTokens = new address[](1);
        sellCapTokens[0] = assets[0];
        uint256[] memory sellCaps = new uint256[](1);
        sellCaps[0] = 100e18;
        StewardAccountV1.PolicyConfig memory c = StewardAccountV1.PolicyConfig({
            settlement: address(settlement),
            period: 1 days,
            anchor: 0,
            paymentLimit: 500e6,
            buyLimit: 1_000e6,
            reserve: 100e6,
            perPayment: 500e6,
            perBuy: 1_000e6,
            perSell: 100e18,
            exceptionQuorum: 2,
            approvedTokens: assets,
            paymentRecipients: recipients,
            exceptionSigners: exceptions,
            guardians: guardians,
            approvedAdapters: adapters,
            sellCapTokens: sellCapTokens,
            sellCaps: sellCaps,
            continuityReviewer: vm.addr(0xABCD),
            continuitySuccessor: vm.addr(0xFACE),
            continuityPlanHash: bytes32(uint256(42))
        });
        account = new StewardAccountV1();
        account.initialize(parent, c);
        settlement.mint(address(account), 10_000e6);
        vm.prank(parent);
        account.setDelegate(delegate, 1, uint64(block.timestamp + 30 days), 500e6);
    }

    function _payment(uint256 id, uint256 amount, uint256 nonce, uint256 exceptionMask) internal view returns (StewardAccountV1.Action memory a) {
        uint256 version;
        (,,,,,,,,,, version) = account.policy();
        a = StewardAccountV1.Action({
            actionId: bytes32(id),
            kind: 0,
            account: address(account),
            actor: delegate,
            chainId: block.chainid,
            securityEpoch: account.securityEpoch(),
            policyVersion: version,
            nonce: nonce,
            tokenIn: address(settlement),
            tokenOut: address(0),
            recipient: recipient,
            amountInRaw: amount,
            minAmountOutRaw: 0,
            adapter: address(0),
            routeHash: bytes32(0),
            validAfter: uint64(block.timestamp - 1),
            deadline: uint64(block.timestamp + 1 days),
            exceptionMask: exceptionMask
        });
    }

    function _sig(StewardAccountV1.Action memory a, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, account.actionHash(a));
        return abi.encodePacked(r, s, v);
    }

    function testPaymentAndAccountWideCap() public {
        StewardAccountV1.Action memory a = _payment(1, 300e6, 1, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(a, delegateKey);
        account.executePayment(a, sigs);
        assertEq(settlement.balanceOf(recipient), 300e6);
        a = _payment(2, 201e6, 2, 0);
        sigs[0] = _sig(a, delegateKey);
        vm.expectRevert(StewardAccountV1.CapExceeded.selector);
        account.executePayment(a, sigs);
    }

    function testExceptionRequiresDistinctSignersAndChargesAboveLimit() public {
        StewardAccountV1.Action memory a = _payment(3, 700e6, 3, 6);
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sig(a, delegateKey);
        sigs[1] = _sig(a, exception1Key);
        sigs[2] = _sig(a, exception2Key);
        account.executePayment(a, sigs);
        assertEq(settlement.balanceOf(recipient), 700e6);
        a = _payment(4, 1, 4, 0);
        sigs = new bytes[](1);
        sigs[0] = _sig(a, delegateKey);
        vm.expectRevert(StewardAccountV1.CapExceeded.selector);
        account.executePayment(a, sigs);
    }

    function testReplayAndChangedRecipientRejected() public {
        StewardAccountV1.Action memory a = _payment(5, 10e6, 5, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(a, delegateKey);
        account.executePayment(a, sigs);
        vm.expectRevert(StewardAccountV1.AlreadyUsed.selector);
        account.executePayment(a, sigs);
        a.actionId = bytes32(uint256(55));
        a.nonce = 55;
        a.recipient = address(0xBEEF);
        sigs[0] = _sig(a, delegateKey);
        vm.expectRevert(StewardAccountV1.Unsupported.selector);
        account.executePayment(a, sigs);
    }

    function testAttackerCannotCancelVictimAction() public {
        StewardAccountV1.Action memory a = _payment(51, 10e6, 51, 0);
        bytes memory victimSig = _sig(a, delegateKey);
        vm.expectRevert(StewardAccountV1.Unauthorized.selector);
        account.cancelOwnAction(a, victimSig);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = victimSig;
        account.executePayment(a, sigs);
        assertEq(settlement.balanceOf(recipient), 10e6);
    }

    function testUnknownExceptionBitRejected() public {
        StewardAccountV1.Action memory a = _payment(52, 700e6, 52, 8);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(a, delegateKey);
        sigs[1] = _sig(a, exception1Key);
        vm.expectRevert(StewardAccountV1.BadApprovals.selector);
        account.executePayment(a, sigs);
    }

    function testCancellationIsActorScopedForCollidingActionId() public {
        StewardAccountV1.Action memory delegated = _payment(60, 10e6, 60, 0);
        bytes memory delegatedSig = _sig(delegated, delegateKey);
        vm.prank(delegate);
        account.cancelOwnAction(delegated, delegatedSig);
        StewardAccountV1.Action memory parentAction = delegated;
        parentAction.actor = parent;
        parentAction.nonce = 61;
        bytes[] memory approvals = new bytes[](1);
        approvals[0] = _sig(parentAction, parentKey);
        account.executePayment(parentAction, approvals);
        assertEq(settlement.balanceOf(recipient), 10e6);
    }

    function testDuplicateExceptionSignatureRejected() public {
        StewardAccountV1.Action memory a = _payment(62, 700e6, 62, 6);
        bytes[] memory approvals = new bytes[](3);
        approvals[0] = _sig(a, delegateKey);
        approvals[1] = _sig(a, exception1Key);
        approvals[2] = _sig(a, exception1Key);
        vm.expectRevert(StewardAccountV1.BadApprovals.selector);
        account.executePayment(a, approvals);
    }

    function testParentGrantsBoundedCaregiverImmediately() public {
        address next = address(0xD311);
        vm.prank(parent);
        account.setDelegate(next, 1, uint64(block.timestamp + 30 days), 500e6);
        (uint256 mask, uint256 limit, uint64 expiry, uint256 epoch, bool enabled) = account.delegates(next);
        assertEq(mask, 1);
        assertEq(limit, 500e6);
        assertGt(expiry, block.timestamp);
        assertEq(epoch, account.securityEpoch());
        assertTrue(enabled);
        (,,,,, bool pending) = account.pendingDelegate();
        assertFalse(pending);
        vm.prank(next);
        vm.expectRevert(StewardAccountV1.Unauthorized.selector);
        account.setDelegate(address(0xD312), 1, uint64(block.timestamp + 30 days), 1e6);
    }

    function testFuzzAccountWideCapCannotBeSplit(uint96 first, uint96 second) public {
        first = uint96(bound(first, 1, 499e6));
        second = uint96(bound(second, 1, 499e6));
        vm.assume(uint256(first) + uint256(second) > 500e6);
        StewardAccountV1.Action memory a = _payment(63, first, 63, 0);
        bytes[] memory approvals = new bytes[](1);
        approvals[0] = _sig(a, delegateKey);
        account.executePayment(a, approvals);
        a = _payment(64, second, 64, 0);
        approvals[0] = _sig(a, delegateKey);
        vm.expectRevert(StewardAccountV1.CapExceeded.selector);
        account.executePayment(a, approvals);
    }

    function testDailyBoundaryAndPolicyTighteningDoNotResetSpent() public {
        StewardAccountV1.Action memory a = _payment(6, 500e6, 6, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(a, delegateKey);
        account.executePayment(a, sigs);
        vm.warp(block.timestamp + 1 days);
        vm.prank(parent);
        account.tightenPolicy(_tightPolicy(100e6));
        a = _payment(7, 100e6, 7, 0);
        sigs[0] = _sig(a, delegateKey);
        account.executePayment(a, sigs);
        assertEq(settlement.balanceOf(recipient), 600e6);
    }

    function _tightPolicy(uint256 limit) internal view returns (StewardAccountV1.PolicyConfig memory c) {
        address[] memory none = new address[](0);
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        c = StewardAccountV1.PolicyConfig({
            settlement: address(settlement), period: 1 days, anchor: 0, paymentLimit: limit, buyLimit: 1_000e6,
            reserve: 100e6, perPayment: limit, perBuy: 1_000e6, perSell: 100e18, exceptionQuorum: 2,
            approvedTokens: none, paymentRecipients: recipients, exceptionSigners: none, guardians: none,
            approvedAdapters: none, sellCapTokens: none, sellCaps: new uint256[](0), continuityReviewer: address(0),
            continuitySuccessor: address(0), continuityPlanHash: bytes32(0)
        });
        address[] memory exceptions = new address[](2);
        exceptions[0] = exception1;
        exceptions[1] = exception2;
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;
        c.exceptionSigners = exceptions;
        c.guardians = guardians;
        c.continuityReviewer = vm.addr(0xABCD);
        c.continuitySuccessor = vm.addr(0xFACE);
        c.continuityPlanHash = bytes32(uint256(42));
    }

    function testRecoveryRotatesEpochAndPreservesSpent() public {
        StewardAccountV1.Action memory a = _payment(8, 100e6, 8, 0);
        uint256 oldPeriod = account.periodStart();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(a, delegateKey);
        account.executePayment(a, sigs);
        vm.prank(guardian1);
        account.startRecovery(vm.addr(0xFACE));
        uint256 recoveryId = account.recoveryNonce();
        vm.prank(guardian2);
        account.approveRecovery(recoveryId);
        vm.warp(block.timestamp + 48 hours + 1);
        account.executeRecovery();
        assertEq(account.parent(), vm.addr(0xFACE));
        assertEq(account.securityEpoch(), 2);
        assertEq(account.paymentSpent(address(settlement), oldPeriod), 100e6);
    }

    function testRecoveryClearsAllPendingAuthorityTransitions() public {
        vm.prank(parent);
        account.queuePolicyExpansion(bytes32(uint256(9001)));
        vm.prank(parent);
        account.setDelegate(address(0xD900), 1, uint64(block.timestamp + 30 days), 10e6);
        vm.prank(parent);
        account.admitAdapter(address(0xA900), true);
        vm.prank(guardian1);
        account.startRecovery(vm.addr(0xFA11));
        uint256 id = account.recoveryNonce();
        vm.prank(guardian2);
        account.approveRecovery(id);
        vm.warp(block.timestamp + 48 hours + 1);
        account.executeRecovery();
        bool policyActive;
        (,,policyActive) = account.pendingPolicy();
        bool delegateActive;
        (,,,,,delegateActive) = account.pendingDelegate();
        assertFalse(policyActive);
        assertFalse(delegateActive);
        assertEq(account.pendingAdapter(), address(0));
    }

    function testFactoryDeploysDirectImmutableAccount() public {
        StewardFactoryV1 factory = new StewardFactoryV1();
        assertTrue(factory.accountCreationCodeHash() != bytes32(0));
        assertEq(factory.MANIFEST(), keccak256("STEWARD_ACCOUNT_V1_MANIFEST_2026-09-23_IMMEDIATE_DELEGATES"));
        address[] memory none = new address[](0);
        address[] memory exceptions = new address[](2);
        exceptions[0] = exception1;
        exceptions[1] = exception2;
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;
        StewardAccountV1.PolicyConfig memory c = StewardAccountV1.PolicyConfig({
            settlement: address(settlement), period: 1 days, anchor: 0, paymentLimit: 1e6, buyLimit: 1e6,
            reserve: 0, perPayment: 1e6, perBuy: 1e6, perSell: 1e18, exceptionQuorum: 2,
            approvedTokens: none, paymentRecipients: none, exceptionSigners: exceptions, guardians: guardians,
            approvedAdapters: none, sellCapTokens: none, sellCaps: new uint256[](0), continuityReviewer: address(0),
            continuitySuccessor: address(0), continuityPlanHash: bytes32(0)
        });
        address clone = factory.createAccount(parent, c);
        StewardAccountV1 cloned = StewardAccountV1(payable(clone));
        assertTrue(cloned.initialized());
        assertEq(cloned.securityEpoch(), 1);
        assertTrue(factory.isStewardAccount(clone));
    }

    function testDeployedRuntimeStaysBelowEIP170Limit() public view {
        assertLe(address(account).code.length, 24_576);
    }

    function testCancellationCannotBeOverwrittenByAnotherActor() public {
        StewardAccountV1.Action memory victim = _payment(900, 1e6, 900, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(victim, delegateKey);
        vm.prank(delegate);
        account.cancelOwnAction(victim, sigs[0]);
        StewardAccountV1.Action memory collision = _payment(900, 1e6, 900, 0);
        collision.actor = parent;
        bytes memory other = _sig(collision, parentKey);
        vm.prank(parent);
        account.cancelOwnAction(collision, other);
        vm.expectRevert(StewardAccountV1.AlreadyUsed.selector);
        account.executePayment(victim, sigs);
    }

    function testParentCanChangeAndRevokeCaregiverWithoutAQueue() public {
        (,,uint64 expiry,,) = account.delegates(delegate);
        vm.prank(parent);
        account.setDelegate(delegate, 1, expiry, 0);
        (,uint256 limit,,,bool enabled) = account.delegates(delegate);
        assertEq(limit, 0);
        assertTrue(enabled);
        (,,,,, bool pending) = account.pendingDelegate();
        assertFalse(pending);
        vm.prank(parent);
        vm.expectRevert(StewardAccountV1.NotReady.selector);
        account.executeDelegateExpansion();
        vm.prank(parent);
        account.revokeDelegate(delegate);
        (,,,,enabled) = account.delegates(delegate);
        assertFalse(enabled);
    }

    function testRecoveredParentCanRegrantInNewEpochImmediately() public {
        vm.prank(guardian1);
        account.startRecovery(vm.addr(0xFA11));
        uint256 id = account.recoveryNonce();
        vm.prank(guardian2);
        account.approveRecovery(id);
        vm.warp(block.timestamp + 48 hours + 1);
        account.executeRecovery();

        // Old authority is stale until the new parent explicitly regrants it.
        (uint256 mask, uint256 limit, uint64 expiry, uint256 oldEpoch,) = account.delegates(delegate);
        assertLt(oldEpoch, account.securityEpoch());
        vm.prank(vm.addr(0xFA11));
        account.setDelegate(delegate, mask, expiry, limit);
        (,,,,, bool pending) = account.pendingDelegate();
        assertFalse(pending);
        (,,,uint256 epoch,bool enabled) = account.delegates(delegate);
        assertEq(epoch, account.securityEpoch());
        assertTrue(enabled);
        assertFalse(account.delegatedSpendingPaused());
    }

    function testPolicyRoleChangesAreRejectedInsteadOfIgnored() public {
        StewardAccountV1.PolicyConfig memory c = _tightPolicy(500e6);
        c.guardians = new address[](0);
        vm.prank(parent);
        vm.expectRevert(StewardAccountV1.InvalidAction.selector);
        account.tightenPolicy(c);
    }

    function testTighteningCannotIncreaseIndividualSellCap() public {
        StewardAccountV1.PolicyConfig memory c = _tightPolicy(500e6);
        c.approvedTokens = new address[](1); c.approvedTokens[0] = stock;
        c.sellCapTokens = new address[](1); c.sellCapTokens[0] = stock;
        c.sellCaps = new uint256[](1); c.sellCaps[0] = 101e18;
        vm.prank(parent);
        vm.expectRevert(StewardAccountV1.InvalidAction.selector);
        account.tightenPolicy(c);
    }

    function testTighteningRemovesDynamicallyAdmittedAdapter() public {
        vm.prank(parent); account.admitAdapter(address(0xABBA), true);
        vm.warp(block.timestamp + 49 hours);
        vm.prank(parent); account.executeAdapterAdmission();
        assertTrue(account.approvedAdapter(address(0xABBA)));
        vm.prank(parent); account.tightenPolicy(_tightPolicy(500e6));
        assertFalse(account.approvedAdapter(address(0xABBA)));
    }

    function testPolicyAddressViewsAndAdapterHistory() public {
        address[] memory values = account.policyAddresses(0);
        assertEq(values.length, 1);
        assertEq(values[0], stock);
        values = account.policyAddresses(1);
        assertEq(values.length, 1);
        assertEq(values[0], recipient);
        values = account.policyAddresses(2);
        assertEq(values.length, 2);
        assertEq(values[0], exception1);
        assertEq(values[1], exception2);
        values = account.policyAddresses(3);
        assertEq(values.length, 3);
        assertEq(values[0], guardian1);
        assertEq(values[1], guardian2);
        assertEq(values[2], guardian3);
        values = account.policyAddresses(4);
        assertEq(values.length, 0);
        values = account.policyAddresses(5);
        assertEq(values.length, 1);
        assertEq(values[0], stock);

        address adapter = address(0xABBA);
        vm.prank(parent);
        account.admitAdapter(adapter, true);
        vm.warp(block.timestamp + 49 hours);
        vm.prank(parent);
        account.executeAdapterAdmission();
        assertTrue(account.approvedAdapter(adapter));
        values = account.policyAddresses(4);
        assertEq(values.length, 1);
        assertEq(values[0], adapter);

        vm.prank(parent);
        account.admitAdapter(adapter, false);
        assertFalse(account.approvedAdapter(adapter));
        values = account.policyAddresses(4);
        assertEq(values.length, 1);
        assertEq(values[0], adapter);

        vm.prank(parent);
        account.tightenPolicy(_tightPolicy(500e6));
        assertEq(account.policyAddresses(0).length, 0);
        assertEq(account.policyAddresses(4).length, 0);
        assertEq(account.policyAddresses(5).length, 0);

        vm.expectRevert(StewardAccountV1.InvalidAction.selector);
        account.policyAddresses(6);
    }

    function testExceptionSignerCanActWithoutCountingAsOwnApprover() public {
        vm.prank(parent); account.setDelegate(exception1, 1, uint64(block.timestamp + 30 days), 500e6);
        StewardAccountV1.Action memory a = _payment(901, 1e6, 901, 0);
        a.actor = exception1;
        bytes[] memory sigs = new bytes[](1); sigs[0] = _sig(a, exception1Key);
        account.executePayment(a, sigs);
        a = _payment(902, 700e6, 902, 6); a.actor = exception1;
        sigs = new bytes[](2); sigs[0] = _sig(a, exception1Key); sigs[1] = _sig(a, exception2Key);
        vm.expectRevert(StewardAccountV1.BadApprovals.selector); account.executePayment(a, sigs);
    }

    function _reviewedSuccession() internal returns (uint256 id) {
        vm.prank(guardian1);
        account.requestSuccession(vm.addr(0xFACE), vm.addr(0xABCD), bytes32(uint256(42)), bytes32(uint256(43)), uint64(block.timestamp + 40 days));
        id = account.recoveryNonce();
        (uint8 v,bytes32 r,bytes32 ss) = vm.sign(0xABCD, account.successionApprovalHash(id));
        bytes memory sig = abi.encodePacked(r,ss,v);
        vm.prank(guardian1); account.approveSuccession(id,sig);
        vm.prank(guardian2); account.approveSuccession(id,sig);
        (v,r,ss) = vm.sign(0xFACE,account.successionAcceptanceHash(id));
        vm.prank(vm.addr(0xFACE)); account.acceptSuccession(id,abi.encodePacked(r,ss,v));
    }

    function testSuccessionClearsOldRecoveryAndAuthorityQueues() public {
        uint256 id = _reviewedSuccession();
        vm.prank(guardian1); account.startRecovery(vm.addr(0xDEAD));
        uint256 recoveryId = account.recoveryNonce();
        vm.prank(guardian2); account.approveRecovery(recoveryId);
        vm.prank(parent); account.queuePolicyExpansion(bytes32(uint256(123)));
        vm.warp(block.timestamp + 14 days + 1);
        account.executeSuccession(id,bytes32(uint256(42)),bytes32(uint256(43)));
        assertEq(account.parent(),vm.addr(0xFACE));
        (,,,,,bool active) = account.recovery(); assertFalse(active);
        (,,active) = account.pendingPolicy(); assertFalse(active);
        vm.expectRevert(StewardAccountV1.NotReady.selector); account.executeRecovery();
    }

    function testExpiredSuccessionCanBeReplacedWithoutInheritedAcceptance() public {
        _reviewedSuccession();
        vm.warp(block.timestamp + 41 days);
        vm.prank(guardian1);
        account.requestSuccession(vm.addr(0xFACE),vm.addr(0xABCD),bytes32(uint256(42)),bytes32(uint256(44)),uint64(block.timestamp+40 days));
        assertFalse(account.successionAccepted());
        vm.prank(parent); account.cancelSuccession();
    }

    function testQuorumFreezeIsBoundedAndDoesNotStartOnRequestAlone() public {
        vm.prank(guardian1); account.startRecovery(vm.addr(0xDEAD));
        StewardAccountV1.Action memory a = _payment(903,1e6,903,0);
        bytes[] memory sigs = new bytes[](1); sigs[0] = _sig(a,delegateKey);
        account.executePayment(a,sigs);
        uint256 recoveryId = account.recoveryNonce();
        vm.prank(guardian2); account.approveRecovery(recoveryId);
        a = _payment(904,1e6,904,0); sigs[0] = _sig(a,delegateKey);
        vm.expectRevert(StewardAccountV1.Paused.selector); account.executePayment(a,sigs);
        vm.warp(block.timestamp + 17 days);
        a = _payment(905,1e6,905,0); sigs[0] = _sig(a,delegateKey);
        account.executePayment(a,sigs);
    }

}
