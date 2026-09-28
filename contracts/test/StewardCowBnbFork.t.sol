// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    StewardCowOrderAccountPrototype,
    IPriceGuardPrototype
} from "../src/prototypes/StewardCowOrderAccountPrototype.sol";

interface IRealCowSettlement {
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
    function domainSeparator() external view returns (bytes32);
    function vaultRelayer() external view returns (address);
    function authenticator() external view returns (address);
    function filledAmount(bytes calldata uid) external view returns (uint256);
    function settle(
        address[] calldata tokens,
        uint256[] calldata prices,
        Trade[] calldata trades,
        Interaction[][3] calldata interactions
    ) external;
    function freeFilledAmountStorage(bytes[] calldata uids) external;
}

interface IRealCowAuthenticator {
    function isSolver(address solver) external view returns (bool);
}

contract BnbForkFixturePriceGuard is IPriceGuardPrototype {
    address public immutable usdc;
    address public immutable stock;
    bool public live = true;

    constructor(address usdc_, address stock_) {
        usdc = usdc_;
        stock = stock_;
    }

    function setLive(bool value) external {
        live = value;
    }

    function minimumOut(address sellToken, address buyToken, uint256 amount) external view returns (uint256) {
        require(live, "fixture stale");
        if (sellToken == usdc && buyToken == stock) return amount * 28 / 10_000; // Fixture: $1 -> 0.0028 AAPLx.
        if (sellToken == stock && buyToken == usdc) return amount * 280; // Fixture: 0.001 AAPLx -> $0.28.
        revert("wrong pair");
    }
}

contract StewardCowBnbForkTest is Test {
    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant AAPLX = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address internal constant SOLVER = 0x98301405Fdc87Db9db736624C5eC37705318CAD5;
    uint256 internal constant CAREGIVER_KEY = 0xCAFE; // Disposable local fork fixture only.
    bytes32 internal constant ORDER_TYPEHASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    IERC20 internal usdc;
    IERC20 internal stock;
    IRealCowSettlement internal settlement;
    BnbForkFixturePriceGuard internal guard;
    StewardCowOrderAccountPrototype internal account;
    address internal parent;
    address internal caregiver;

    function setUp() public {
        if (block.chainid != 56) {
            vm.skip(true, "pinned BNB fork only");
            return;
        }
        usdc = IERC20(USDC);
        stock = IERC20(AAPLX);
        settlement = IRealCowSettlement(SETTLEMENT);
        assertEq(settlement.vaultRelayer(), RELAYER);
        assertTrue(IRealCowAuthenticator(settlement.authenticator()).isSolver(SOLVER));
        assertGt(stock.balanceOf(SETTLEMENT), 3e15);
        assertGt(usdc.balanceOf(SETTLEMENT), 2e18);
        parent = vm.addr(0xA11CE);
        caregiver = vm.addr(CAREGIVER_KEY);
        assertEq(caregiver.code.length, 0, "fixture signer collided with deployed contract");
        guard = new BnbForkFixturePriceGuard(USDC, AAPLX);
        address[2] memory cosigners = [vm.addr(0xC01), vm.addr(0xC02)];
        uint256[6] memory limits = [uint256(2e18), 5e18, 1e17, 1e16, 2e16, 500];
        account = new StewardCowOrderAccountPrototype(
            parent, SETTLEMENT, RELAYER, USDC, AAPLX, address(0xBEEF), address(guard), caregiver, cosigners, limits
        );
        // Fork-only funding from the public settlement inventory. This is a fixture counterparty, not market liquidity.
        vm.prank(SETTLEMENT);
        require(usdc.transfer(address(account), 2e18), "fixture funding failed");
    }

    function _order(bool buy, uint256 sellAmount, uint256 id)
        internal
        view
        returns (StewardCowOrderAccountPrototype.CowOrder memory o)
    {
        uint256 periodEnd = uint256(account.periodStart()) + account.PERIOD();
        uint256 expiry = block.timestamp + 600 < periodEnd ? block.timestamp + 600 : periodEnd - 1;
        o = StewardCowOrderAccountPrototype.CowOrder({
            sellToken: buy ? USDC : AAPLX,
            buyToken: buy ? AAPLX : USDC,
            receiver: address(account),
            sellAmount: sellAmount,
            buyAmount: buy ? sellAmount * 28 / 10_000 : sellAmount * 280,
            validTo: uint32(expiry),
            appData: bytes32(id),
            feeAmount: sellAmount / 100,
            kind: account.KIND_SELL(),
            partiallyFillable: false,
            sellTokenBalance: account.BALANCE_ERC20(),
            buyTokenBalance: account.BALANCE_ERC20()
        });
    }

    function _canonicalDigest(StewardCowOrderAccountPrototype.CowOrder memory o) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.sellToken,
                o.buyToken,
                o.receiver,
                o.sellAmount,
                o.buyAmount,
                o.validTo,
                o.appData,
                o.feeAmount,
                o.kind,
                o.partiallyFillable,
                o.sellTokenBalance,
                o.buyTokenBalance
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", settlement.domainSeparator(), structHash));
    }

    function _open(StewardCowOrderAccountPrototype.CowOrder memory o, uint256 nonce) internal returns (bytes32 digest) {
        digest = _canonicalDigest(o); // Independent from account.orderDigest.
        assertEq(account.orderDigest(o), digest);
        bytes32 approvalDigest = account.openDigest(digest, caregiver, nonce, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CAREGIVER_KEY, approvalDigest);
        StewardCowOrderAccountPrototype.Approval[] memory approvals = new StewardCowOrderAccountPrototype.Approval[](1);
        approvals[0] = StewardCowOrderAccountPrototype.Approval(caregiver, abi.encodePacked(r, s, v));
        assertEq(account.openOrder(o, caregiver, nonce, 0, approvals), digest);
    }

    function _trade(StewardCowOrderAccountPrototype.CowOrder memory o, bytes32 digest)
        internal
        view
        returns (IRealCowSettlement.Trade memory t, address[] memory tokens, uint256[] memory prices)
    {
        t = IRealCowSettlement.Trade({
            sellTokenIndex: 0,
            buyTokenIndex: 1,
            receiver: o.receiver,
            sellAmount: o.sellAmount,
            buyAmount: o.buyAmount,
            validTo: o.validTo,
            appData: o.appData,
            feeAmount: o.feeAmount,
            flags: 64,
            executedAmount: 0,
            signature: abi.encodePacked(address(account), abi.encode(digest))
        });
        tokens = new address[](2);
        tokens[0] = o.sellToken;
        tokens[1] = o.buyToken;
        prices = new uint256[](2);
        if (o.sellToken == USDC) {
            prices[0] = 3e15;
            prices[1] = 1e18;
        } else {
            prices[0] = 3e17;
            prices[1] = 1e15;
        }
    }

    function _settle(StewardCowOrderAccountPrototype.CowOrder memory o, bytes32 digest) internal {
        (IRealCowSettlement.Trade memory t, address[] memory tokens, uint256[] memory prices) = _trade(o, digest);
        IRealCowSettlement.Trade[] memory trades = new IRealCowSettlement.Trade[](1);
        trades[0] = t;
        IRealCowSettlement.Interaction[][3] memory interactions;
        vm.prank(SOLVER);
        settlement.settle(tokens, prices, trades, interactions);
    }

    function testRealSettlementBuyAndSellFixtureCounterparty() public {
        StewardCowOrderAccountPrototype.CowOrder memory buy = _order(true, 1e18, 1);
        bytes32 buyDigest = _open(buy, 1);
        bytes memory buyUid = abi.encodePacked(buyDigest, address(account), buy.validTo);
        assertEq(keccak256(account.orderUid(buyDigest, buy.validTo)), keccak256(buyUid));
        assertEq(usdc.allowance(address(account), RELAYER), 1.01e18);
        uint256 usdBefore = usdc.balanceOf(address(account));
        uint256 stockBefore = stock.balanceOf(address(account));
        _settle(buy, buyDigest);
        assertEq(settlement.filledAmount(buyUid), buy.sellAmount);
        assertEq(usdBefore - usdc.balanceOf(address(account)), 1.01e18);
        // AAPLx is share-based and its balanceOf may round a nominal transfer down by one base unit.
        assertApproxEqAbs(stock.balanceOf(address(account)) - stockBefore, 3e15, 1);
        account.reconcile(buyDigest);
        assertEq(usdc.allowance(address(account), RELAYER), 0);

        StewardCowOrderAccountPrototype.CowOrder memory sell = _order(false, 1e15, 2);
        bytes32 sellDigest = _open(sell, 2);
        uint256 stockBeforeSell = stock.balanceOf(address(account));
        uint256 usdBeforeSell = usdc.balanceOf(address(account));
        _settle(sell, sellDigest);
        assertEq(settlement.filledAmount(abi.encodePacked(sellDigest, address(account), sell.validTo)), sell.sellAmount);
        assertEq(stockBeforeSell - stock.balanceOf(address(account)), 1.01e15);
        assertEq(usdc.balanceOf(address(account)) - usdBeforeSell, 3e17);
        account.reconcile(sellDigest);
        assertEq(stock.allowance(address(account), RELAYER), 0);
    }

    function testRealSettlementRejectsCancelRevokeAndStaleFixtureGuard() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 1e18, 3);
        bytes32 digest = _open(o, 3);
        vm.prank(parent);
        account.cancelOrder(digest);
        vm.expectRevert(bytes("GPv2: invalid eip1271 signature"));
        _settle(o, digest);

        o = _order(true, 1e18, 4);
        digest = _open(o, 4);
        vm.prank(parent);
        account.revokeCaregiver();
        vm.expectRevert(bytes("GPv2: invalid eip1271 signature"));
        _settle(o, digest);
        account.reconcile(digest);

        vm.prank(parent);
        account.setCaregiver(caregiver, uint64(block.timestamp + 1 days));
        o = _order(true, 1e18, 5);
        digest = _open(o, 5);
        guard.setLive(false);
        vm.expectRevert(bytes("GPv2: invalid eip1271 signature"));
        _settle(o, digest);
    }

    function testRealSettlementClearsExpiredFillRecordConservatively() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 1e18, 6);
        bytes32 digest = _open(o, 6);
        bytes memory uid = abi.encodePacked(digest, address(account), o.validTo);
        _settle(o, digest);
        assertEq(settlement.filledAmount(uid), o.sellAmount);
        vm.warp(uint256(o.validTo) + 1);
        IRealCowSettlement.Interaction[][3] memory interactions;
        interactions[0] = new IRealCowSettlement.Interaction[](1);
        bytes[] memory uids = new bytes[](1);
        uids[0] = uid;
        interactions[0][0] = IRealCowSettlement.Interaction(
            SETTLEMENT, 0, abi.encodeCall(IRealCowSettlement.freeFilledAmountStorage, (uids))
        );
        IRealCowSettlement.Trade[] memory noTrades = new IRealCowSettlement.Trade[](0);
        address[] memory noTokens = new address[](0);
        uint256[] memory noPrices = new uint256[](0);
        vm.prank(SOLVER);
        settlement.settle(noTokens, noPrices, noTrades, interactions);
        assertEq(settlement.filledAmount(uid), 0);
        account.reconcile(digest);
        assertEq(account.buySpent(account.periodStart()), 1.01e18);
        (,,,,,,,,,,, uint8 state) = account.orders(digest);
        assertEq(state, 4);
    }
}
