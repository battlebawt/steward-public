// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {StewardIncapacityModuleV1} from "../src/StewardIncapacityModuleV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";

contract StewardIncapacityTest is Test {
    uint256 parentKey = 0x101;
    uint256 reviewerKey = 0x202;
    uint256 g1Key = 0x301;
    uint256 g2Key = 0x302;
    uint256 g3Key = 0x303;
    uint256 successorKey = 0x404;
    address parent;
    address reviewer;
    address g1;
    address g2;
    address g3;
    address caregiver = address(0xCA11);
    address successor;
    StewardAccountV1 account;
    StewardIncapacityModuleV1 module;

    function setUp() public {
        parent = vm.addr(parentKey);
        reviewer = vm.addr(reviewerKey);
        g1 = vm.addr(g1Key);
        g2 = vm.addr(g2Key);
        g3 = vm.addr(g3Key);
        successor = vm.addr(successorKey);
        MockStewardToken settlement = new MockStewardToken("USDG", "USDG", 6);
        address[] memory empty = new address[](0);
        address[] memory exceptions = new address[](2);
        exceptions[0] = address(0xE1);
        exceptions[1] = address(0xE2);
        address[] memory guardians = new address[](3);
        guardians[0] = g1;
        guardians[1] = g2;
        guardians[2] = g3;
        StewardAccountV1.PolicyConfig memory p = StewardAccountV1.PolicyConfig({
            settlement: address(settlement), period: 1 days, anchor: 0, paymentLimit: 100e6, buyLimit: 100e6,
            reserve: 0, perPayment: 20e6, perBuy: 20e6, perSell: 20e18, exceptionQuorum: 2,
            approvedTokens: empty, paymentRecipients: empty, exceptionSigners: exceptions, guardians: guardians,
            approvedAdapters: empty, sellCapTokens: empty, sellCaps: new uint256[](0), continuityReviewer: reviewer,
            continuitySuccessor: successor, continuityPlanHash: keccak256("SUCCESSION-PLAN")
        });
        account = new StewardAccountV1();
        account.initialize(parent, p);
        address[] memory moduleGuardians = new address[](3);
        moduleGuardians[0] = g1;
        moduleGuardians[1] = g2;
        moduleGuardians[2] = g3;
        module = new StewardIncapacityModuleV1(
            address(account), caregiver, reviewer, moduleGuardians, 2, 1, 10e6, keccak256("PLAN-V1"), 1 days, 7 days
        );
        vm.prank(parent);
        account.queueIncapacityModule(address(module), caregiver, 1, 10e6);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(parent);
        account.executeIncapacityModule();
    }

    function _reviewerSig(uint256 id) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reviewerKey, module.reviewHash(id));
        return abi.encodePacked(r, s, v);
    }

    function testReviewerQuorumChallengeResolveAndActivation() public {
        uint64 deadline = uint64(block.timestamp + 10 days);
        vm.prank(g1);
        uint256 id = module.request(keccak256("EVIDENCE-1"), deadline);
        bytes memory sig = _reviewerSig(id);
        vm.prank(g1);
        module.approve(id, sig);
        vm.prank(g2);
        module.approve(id, sig);
        vm.prank(g3);
        module.challenge(id);
        vm.prank(reviewer);
        module.resolve(id, true);
        vm.warp(block.timestamp + 1 days + 1);
        module.execute(id);
        (uint256 mask, uint256 limit, uint64 expiry, uint256 epoch, bool enabled) = account.delegates(caregiver);
        assertEq(mask, 1);
        assertEq(limit, 10e6);
        assertGt(expiry, block.timestamp);
        assertEq(epoch, account.securityEpoch());
        assertTrue(enabled);
        assertTrue(account.incapacityActive());
        assertEq(account.parent(), parent);
    }

    function testMaliciousCallerCannotActivateOrDuplicateGuardianApproval() public {
        uint256 epoch = account.securityEpoch();
        vm.expectRevert();
        account.activateIncapacity(caregiver, 1, 10e6, epoch, uint64(block.timestamp + 1 days));
        vm.prank(g1);
        uint256 id = module.request(keccak256("EVIDENCE-2"), uint64(block.timestamp + 10 days));
        bytes memory sig = _reviewerSig(id);
        vm.prank(g1);
        module.approve(id, sig);
        vm.prank(g1);
        vm.expectRevert(StewardIncapacityModuleV1.BadSignature.selector);
        module.approve(id, sig);
    }

    function testParentCanCancelPendingCase() public {
        vm.prank(g1);
        uint256 id = module.request(keccak256("EVIDENCE-3"), uint64(block.timestamp + 10 days));
        vm.prank(parent);
        module.cancel(id);
        (, , , , , , , uint8 state, ) = module.current();
        assertEq(state, 6);
    }

    function testRequestedAndChallengedExpiryClearCases() public {
        uint64 firstDeadline = uint64(block.timestamp + 1 days);
        vm.prank(g1);
        uint256 firstId = module.request(keccak256("EVIDENCE-4"), firstDeadline);

        vm.warp(uint256(firstDeadline) + 1);
        module.expire(firstId);
        (,,,,,,, uint8 state,) = module.current();
        assertEq(state, 7);

        uint64 secondDeadline = uint64(block.timestamp + 2 days);
        vm.prank(g1);
        uint256 secondId = module.request(keccak256("EVIDENCE-5"), secondDeadline);
        bytes memory sig = _reviewerSig(secondId);
        vm.prank(g1);
        module.approve(secondId, sig);
        vm.prank(g2);
        module.approve(secondId, sig);
        vm.prank(g3);
        module.challenge(secondId);
        (,,,,,,, state,) = module.current();
        assertEq(state, 3);

        vm.warp(uint256(secondDeadline) + 1);
        module.expire(secondId);
        (,,,,,,, state,) = module.current();
        assertEq(state, 7);

        uint64 thirdDeadline = uint64(uint256(secondDeadline) + 1 days + 1);
        vm.prank(g2);
        uint256 thirdId = module.request(keccak256("EVIDENCE-6"), thirdDeadline);
        assertEq(thirdId, secondId + 1);
    }

    function testExecutedExpiryDeactivatesIncapacity() public {
        uint64 deadline = uint64(block.timestamp + 5 days);
        vm.prank(g1);
        uint256 id = module.request(keccak256("EVIDENCE-7"), deadline);
        bytes memory sig = _reviewerSig(id);
        vm.prank(g1);
        module.approve(id, sig);
        vm.prank(g2);
        module.approve(id, sig);
        vm.warp(block.timestamp + 1 days + 1);
        module.execute(id);
        assertTrue(account.incapacityActive());
        (,,,, bool enabled) = account.delegates(caregiver);
        assertTrue(enabled);

        vm.warp(uint256(deadline) + 1);
        module.expire(id);
        (,,,,,,, uint8 state,) = module.current();
        assertEq(state, 7);
        assertFalse(account.incapacityActive());
        (,,,, enabled) = account.delegates(caregiver);
        assertFalse(enabled);
    }

    function testRecoveryInvalidatesOldModuleAndCaregiverArrangement() public {
        vm.prank(g1);
        account.startRecovery(vm.addr(0xF00D));
        uint256 recoveryId = account.recoveryNonce();
        vm.prank(g2);
        account.approveRecovery(recoveryId);
        vm.warp(block.timestamp + 48 hours + 1);
        account.executeRecovery();

        assertEq(account.incapacityModule(), address(0));
        assertEq(account.incapacityCaregiver(), address(0));
        assertFalse(account.incapacityActive());

        // The old module can still collect its own old guardian quorum, but
        // it cannot reinstall the caregiver after the account epoch rotates.
        vm.prank(g1);
        uint256 id = module.request(keccak256("STALE-EVIDENCE"), uint64(block.timestamp + 10 days));
        bytes memory sig = _reviewerSig(id);
        vm.prank(g1); module.approve(id, sig);
        vm.prank(g2); module.approve(id, sig);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(StewardAccountV1.Unauthorized.selector);
        module.execute(id);
        assertFalse(account.incapacityActive());
    }

    function testSuccessionInvalidatesOldModuleAndCaregiverArrangement() public {
        bytes32 planHash = keccak256("SUCCESSION-PLAN");
        bytes32 evidenceHash = keccak256("SUCCESSION-EVIDENCE");
        uint64 deadline = uint64(block.timestamp + 40 days);
        vm.prank(g1);
        account.requestSuccession(successor, reviewer, planHash, evidenceHash, deadline);
        uint256 id = account.recoveryNonce();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reviewerKey, account.successionApprovalHash(id));
        bytes memory reviewerSig = abi.encodePacked(r, s, v);
        vm.prank(g1); account.approveSuccession(id, reviewerSig);
        vm.prank(g2); account.approveSuccession(id, reviewerSig);
        (v, r, s) = vm.sign(successorKey, account.successionAcceptanceHash(id));
        vm.prank(successor); account.acceptSuccession(id, abi.encodePacked(r, s, v));
        vm.warp(block.timestamp + 14 days + 1);
        account.executeSuccession(id, planHash, evidenceHash);

        assertEq(account.incapacityModule(), address(0));
        assertEq(account.incapacityCaregiver(), address(0));
        assertEq(account.securityEpoch(), 2);

        vm.prank(g1);
        uint256 caseId = module.request(keccak256("STALE-SUCCESSION-EVIDENCE"), uint64(block.timestamp + 10 days));
        reviewerSig = _reviewerSig(caseId);
        vm.prank(g1); module.approve(caseId, reviewerSig);
        vm.prank(g2); module.approve(caseId, reviewerSig);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(StewardAccountV1.Unauthorized.selector);
        module.execute(caseId);
    }
}
