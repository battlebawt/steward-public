// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {StewardAccountV2Prototype} from "../src/v2/StewardAccountV2Prototype.sol";
import {StewardFactoryV2Prototype} from "../src/v2/StewardFactoryV2Prototype.sol";
import {StewardCowV2Module} from "../src/v2/StewardCowV2Module.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";
import {V2FixtureSettlement, V2FixtureGuard} from "./StewardV2CowIntegration.t.sol";

contract StewardFactoryV2PrototypeTest is Test {
    StewardFactoryV2Prototype factory;
    MockStewardToken token;

    function setUp() public {
        token = new MockStewardToken("Mock settlement asset", "MOCK", 18);
        MockStewardToken stock = new MockStewardToken("Mock stock asset", "MSTK", 18);
        StewardCowV2Module module = new StewardCowV2Module(
            address(new V2FixtureSettlement()), address(stock), address(new V2FixtureGuard()), 500
        );
        factory = new StewardFactoryV2Prototype(address(module));
    }

    function policy() internal view returns (StewardAccountV1.PolicyConfig memory p) {
        address[] memory signers = new address[](2);
        signers[0] = address(0x201);
        signers[1] = address(0x202);
        address[] memory guardians = new address[](3);
        guardians[0] = address(0x301);
        guardians[1] = address(0x302);
        guardians[2] = address(0x303);
        p = StewardAccountV1.PolicyConfig({
            settlement: address(token), period: 1 days, anchor: 0,
            paymentLimit: 1000e18, buyLimit: 1000e18, reserve: 100e18,
            perPayment: 100e18, perBuy: 100e18, perSell: 100e18,
            exceptionQuorum: 2, approvedTokens: new address[](0),
            paymentRecipients: new address[](0), exceptionSigners: signers,
            guardians: guardians, approvedAdapters: new address[](0),
            sellCapTokens: new address[](0), sellCaps: new uint256[](0),
            continuityReviewer: address(0x401), continuitySuccessor: address(0x402),
            continuityPlanHash: bytes32(uint256(1))
        });
    }

    function testFixedComponentsParentAndRuntimeMembership() public {
        StewardAccountV1.PolicyConfig memory p = policy();
        address one = factory.createAccount(address(0x101), p);
        address two = factory.createAccount(address(0x102), p);
        assertTrue(factory.isStewardAccount(one));
        assertTrue(factory.isStewardAccount(two));
        assertEq(factory.accountRuntimeCodeHash(), one.codehash);
        assertEq(one.codehash, two.codehash);
        assertEq(StewardAccountV2Prototype(payable(one)).v1Implementation(), factory.v1Implementation());
        assertEq(StewardAccountV2Prototype(payable(two)).cowModule(), factory.cowModule());
        assertEq(StewardAccountV1(payable(one)).parent(), address(0x101));
        assertEq(StewardAccountV1(payable(two)).parent(), address(0x102));
        assertEq(factory.accountCount(), 2);
    }

    function testInvalidParentAndPolicyCannotRegister() public {
        StewardAccountV1.PolicyConfig memory p = policy();
        vm.expectRevert(StewardAccountV1.InvalidAction.selector);
        factory.createAccount(address(0), p);
        p.exceptionQuorum = 0;
        vm.expectRevert(StewardAccountV1.InvalidAction.selector);
        factory.createAccount(address(0x101), p);
        assertEq(factory.accountCount(), 0);
    }
}
