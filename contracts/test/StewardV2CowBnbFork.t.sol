// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {IPriceGuardPrototype} from "../src/prototypes/StewardCowOrderAccountPrototype.sol";
import {StewardAccountV2Prototype} from "../src/v2/StewardAccountV2Prototype.sol";
import {StewardCowV2Module} from "../src/v2/StewardCowV2Module.sol";

interface IV2RealCowSettlement {
    struct Trade {
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        uint256 flags;
        uint256 executedAmount;
        bytes signature;
    }

    struct Interaction {
        address target;
        uint256 value;
        bytes callData;
    }
    function vaultRelayer() external view returns (address);
    function filledAmount(bytes calldata uid) external view returns (uint256);
    function settle(
        address[] calldata tokens,
        uint256[] calldata prices,
        Trade[] calldata trades,
        Interaction[][3] calldata interactions
    ) external;
}

interface IV2RealCowAuthenticator {
    function isSolver(address solver) external view returns (bool);
}

interface IV2RealCowAuthenticatorSource {
    function authenticator() external view returns (address);
}

contract V2BnbFixtureGuard is IPriceGuardPrototype {
    address public immutable usdc;
    address public immutable stock;

    constructor(address usdc_, address stock_) {
        usdc = usdc_;
        stock = stock_;
    }

    function minimumOut(address sell, address buy, uint256 amount) external view returns (uint256) {
        require(sell == usdc && buy == stock, "fixture pair only");
        return amount * 28 / 10_000;
    }
}

contract StewardV2CowBnbForkTest is Test {
    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant AAPLX = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant SOLVER = 0x98301405Fdc87Db9db736624C5eC37705318CAD5;
    uint256 internal constant CAREGIVER_KEY = 0xCAFE; // Disposable local fork fixture only.
    StewardAccountV1 internal v1;
    StewardCowV2Module internal cow;
    StewardAccountV2Prototype internal shell;
    IV2RealCowSettlement internal settlement;
    address internal caregiver;

    function setUp() public {
        if (block.chainid != 56) {
            vm.skip(true, "pinned BNB fork only");
            return;
        }
        settlement = IV2RealCowSettlement(SETTLEMENT);
        assertTrue(IV2RealCowAuthenticator(IV2RealCowAuthenticatorSource(SETTLEMENT).authenticator()).isSolver(SOLVER));
        assertGt(IERC20(USDC).balanceOf(SETTLEMENT), 2e18);
        assertGt(IERC20(AAPLX).balanceOf(SETTLEMENT), 3e15);
        caregiver = vm.addr(CAREGIVER_KEY);
        assertEq(caregiver.code.length, 0);
        v1 = new StewardAccountV1();
        cow = new StewardCowV2Module(SETTLEMENT, AAPLX, address(new V2BnbFixtureGuard(USDC, AAPLX)), 500);
        address[] memory assets = new address[](1);
        assets[0] = AAPLX;
        address[] memory recipients = new address[](1);
        recipients[0] = address(0xD00D);
        address[] memory exceptions = new address[](2);
        exceptions[0] = vm.addr(0xE01);
        exceptions[1] = vm.addr(0xE02);
        address[] memory guardians = new address[](3);
        guardians[0] = vm.addr(0xC01);
        guardians[1] = vm.addr(0xC02);
        guardians[2] = vm.addr(0xC03);
        address[] memory adapters = new address[](0);
        address[] memory sellTokens = new address[](1);
        sellTokens[0] = AAPLX;
        uint256[] memory sellCaps = new uint256[](1);
        sellCaps[0] = 1e18;
        StewardAccountV1.PolicyConfig memory p = StewardAccountV1.PolicyConfig({
            settlement: USDC,
            period: 1 days,
            anchor: 0,
            paymentLimit: 2e18,
            buyLimit: 2e18,
            reserve: 0,
            perPayment: 2e18,
            perBuy: 2e18,
            perSell: 1e18,
            exceptionQuorum: 2,
            approvedTokens: assets,
            paymentRecipients: recipients,
            exceptionSigners: exceptions,
            guardians: guardians,
            approvedAdapters: adapters,
            sellCapTokens: sellTokens,
            sellCaps: sellCaps,
            continuityReviewer: vm.addr(0xABCD),
            continuitySuccessor: vm.addr(0xFACE),
            continuityPlanHash: bytes32(uint256(42))
        });
        address parent = vm.addr(0xA11CE);
        shell = new StewardAccountV2Prototype(address(v1), address(cow), parent, p);
        v1 = StewardAccountV1(payable(address(shell)));
        vm.prank(SETTLEMENT);
        require(IERC20(USDC).transfer(address(shell), 2e18), "fixture funding");
        vm.prank(parent);
        v1.setDelegate(caregiver, 2, uint64(block.timestamp + 1 days), 2e18);
    }

    function testRealCowSettlementAcceptsV2FixedModuleSignature() public {
        uint256 end = v1.periodStart() + 1 days;
        uint32 validTo = uint32(block.timestamp + 600 < end ? block.timestamp + 600 : end - 1);
        StewardCowV2Module.CowOrder memory o = StewardCowV2Module.CowOrder({
            sellToken: USDC,
            buyToken: AAPLX,
            receiver: address(shell),
            sellAmount: 1e18,
            buyAmount: 28e14,
            validTo: validTo,
            appData: bytes32(uint256(1)),
            feeAmount: 1e16,
            kind: cow.KIND_SELL(),
            partiallyFillable: false,
            sellTokenBalance: cow.BALANCE_ERC20(),
            buyTokenBalance: cow.BALANCE_ERC20()
        });
        bytes32 digest = StewardCowV2Module(address(shell)).orderDigest(o);
        (,,,,,,,,,, uint256 version) = v1.policy();
        StewardAccountV1.Action memory a = StewardAccountV1.Action({
            actionId: digest,
            kind: 1,
            account: address(shell),
            actor: caregiver,
            chainId: block.chainid,
            securityEpoch: v1.securityEpoch(),
            policyVersion: version,
            nonce: 1,
            tokenIn: USDC,
            tokenOut: AAPLX,
            recipient: address(shell),
            amountInRaw: 1.01e18,
            minAmountOutRaw: o.buyAmount,
            adapter: SETTLEMENT,
            routeHash: digest,
            validAfter: uint64(block.timestamp - 1),
            deadline: validTo,
            exceptionMask: 0
        });
        (uint8 sigV, bytes32 sigR, bytes32 sigS) = vm.sign(CAREGIVER_KEY, v1.actionHash(a));
        bytes[] memory approvals = new bytes[](1);
        approvals[0] = abi.encodePacked(sigR, sigS, sigV);
        assertEq(StewardCowV2Module(address(shell)).openOrder(o, a, approvals), digest);
        assertEq(IERC20(USDC).allowance(address(shell), settlement.vaultRelayer()), 1.01e18);
        IV2RealCowSettlement.Trade[] memory trades = new IV2RealCowSettlement.Trade[](1);
        trades[0] = IV2RealCowSettlement.Trade({
            sellTokenIndex: 0,
            buyTokenIndex: 1,
            receiver: address(shell),
            sellAmount: o.sellAmount,
            buyAmount: o.buyAmount,
            validTo: validTo,
            appData: o.appData,
            feeAmount: o.feeAmount,
            flags: 64,
            executedAmount: 0,
            signature: abi.encodePacked(address(shell), abi.encode(digest))
        });
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = AAPLX;
        uint256[] memory prices = new uint256[](2);
        prices[0] = 3e15;
        prices[1] = 1e18;
        IV2RealCowSettlement.Interaction[][3] memory interactions;
        uint256 beforeStock = IERC20(AAPLX).balanceOf(address(shell));
        vm.prank(SOLVER);
        settlement.settle(tokens, prices, trades, interactions);
        bytes memory uid = abi.encodePacked(digest, address(shell), validTo);
        assertEq(settlement.filledAmount(uid), 1e18);
        assertGe(IERC20(AAPLX).balanceOf(address(shell)) - beforeStock, o.buyAmount);
        StewardCowV2Module(address(shell)).reconcile(digest);
        assertEq(IERC20(USDC).allowance(address(shell), settlement.vaultRelayer()), 0);
        (uint256 reserved, uint256 pending, uint256 spent) =
            StewardCowV2Module(address(shell)).budgetStatus(USDC, v1.periodStart());
        assertEq(reserved, 0);
        assertEq(pending, 0);
        assertEq(spent, 1.01e18);
    }
}
