// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StewardAccountV1} from "../src/StewardAccountV1.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";
import {IStewardTradeAdapter} from "../src/interfaces/IStewardTradeAdapter.sol";
import {ICowSettlementPrototype, IPriceGuardPrototype} from "../src/prototypes/StewardCowOrderAccountPrototype.sol";
import {StewardAccountV2Prototype} from "../src/v2/StewardAccountV2Prototype.sol";
import {StewardCowV2Module} from "../src/v2/StewardCowV2Module.sol";
import {StewardCowV2Storage} from "../src/v2/StewardCowV2Storage.sol";

contract V2FixtureRelayer {
    address public immutable settlement;

    constructor(address settlement_) {
        settlement = settlement_;
    }

    function pull(address token, address owner, uint256 amount) external {
        require(msg.sender == settlement, "settlement only");
        require(IERC20(token).transferFrom(owner, settlement, amount), "pull failed");
    }
}

contract V2FixtureSettlement is ICowSettlementPrototype {
    mapping(bytes => uint256) public filledAmount;
    V2FixtureRelayer public immutable relayer;
    bytes32 public immutable domainSeparator;

    constructor() {
        relayer = new V2FixtureRelayer(address(this));
        domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Gnosis Protocol"),
                keccak256("v2"),
                block.chainid,
                address(this)
            )
        );
    }

    function vaultRelayer() external view returns (address) {
        return address(relayer);
    }

    function fill(address account, StewardCowV2Module.CowOrder calldata o) external {
        bytes32 digest = StewardCowV2Module(account).orderDigest(o);
        bytes memory uid = abi.encodePacked(digest, account, o.validTo);
        require(filledAmount[uid] == 0, "already filled");
        require(
            StewardCowV2Module(account).isValidSignature(digest, abi.encode(digest)) == 0x1626ba7e, "invalid signature"
        );
        relayer.pull(o.sellToken, account, o.sellAmount + o.feeAmount);
        MockStewardToken(o.buyToken).mint(account, o.buyAmount);
        filledAmount[uid] = o.sellAmount;
    }

    function clear(bytes calldata uid) external {
        filledAmount[uid] = 0;
    }
}

contract V2FixtureGuard is IPriceGuardPrototype {
    bool public live = true;

    function setLive(bool value) external {
        live = value;
    }

    function minimumOut(address, address, uint256 amount) external view returns (uint256) {
        require(live, "stale");
        return amount * 95 / 100;
    }
}

contract V2FixtureAdapter is IStewardTradeAdapter {
    bytes32 public constant ROUTE = keccak256("V2_FIXTURE_ROUTE");

    function quote(address, address, uint256 amount) external pure returns (uint256) {
        return amount;
    }

    function independentFloor(address, address, uint256 amount) external pure returns (uint256) {
        return amount * 95 / 100;
    }

    function routeHash(address, address) external pure returns (bytes32) {
        return ROUTE;
    }

    function swap(address tokenIn, address tokenOut, uint256 amount, uint256 minOut, address recipient, bytes32 route)
        external
        returns (uint256)
    {
        require(route == ROUTE && amount >= minOut, "bad route");
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amount), "pull failed");
        MockStewardToken(tokenOut).mint(recipient, amount);
        return amount;
    }
}

contract V2CallbackToken is MockStewardToken {
    address public target;
    bytes public payload;
    uint8 public mode; // 1: before transfer debit, 2: during approve
    bool public lastSuccess;
    bytes4 public lastError;

    constructor() MockStewardToken("USDC callback fixture", "USDC", 18) {}

    function arm(address target_, bytes calldata payload_, uint8 mode_) external {
        target = target_;
        payload = payload_;
        mode = mode_;
        lastSuccess = false;
        lastError = bytes4(0);
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        if (mode == 2) _trigger();
        return super.approve(spender, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (mode == 1 && from == target && to != address(0)) _trigger();
        super._update(from, to, amount);
    }

    function _trigger() internal {
        mode = 0;
        (bool ok, bytes memory result) = target.call(payload);
        lastSuccess = ok;
        if (!ok && result.length >= 4) {
            bytes4 reason;
            assembly { reason := mload(add(result, 32)) }
            lastError = reason;
        }
    }
}

contract V2CallbackAdapter is IStewardTradeAdapter {
    bytes32 public constant ROUTE = keccak256("V2_CALLBACK_ROUTE");
    address public target;
    bytes public payload;
    bool public lastSuccess;
    bytes4 public lastError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        lastSuccess = false;
        lastError = bytes4(0);
    }

    function quote(address, address, uint256 amount) external pure returns (uint256) {
        return amount;
    }

    function independentFloor(address, address, uint256 amount) external pure returns (uint256) {
        return amount * 95 / 100;
    }

    function routeHash(address, address) external pure returns (bytes32) {
        return ROUTE;
    }

    function swap(address tokenIn, address tokenOut, uint256 amount, uint256 minOut, address recipient, bytes32 route)
        external
        returns (uint256)
    {
        require(route == ROUTE && amount >= minOut, "bad route");
        (bool ok, bytes memory result) = target.call(payload);
        lastSuccess = ok;
        if (!ok && result.length >= 4) {
            bytes4 reason;
            assembly { reason := mload(add(result, 32)) }
            lastError = reason;
        }
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amount), "pull failed");
        MockStewardToken(tokenOut).mint(recipient, amount);
        return amount;
    }
}

contract StewardV2CowIntegrationTest is Test {
    uint256 internal constant PARENT_KEY = 0xA11CE;
    uint256 internal constant CAREGIVER_KEY = 0xB0B;
    uint256 internal constant G1 = 0xC01;
    uint256 internal constant G2 = 0xC02;
    uint256 internal constant G3 = 0xC03;
    uint256 internal constant E1 = 0xE01;
    uint256 internal constant E2 = 0xE02;
    address internal parent;
    address internal caregiver;
    address internal recipient = address(0xD00D);
    V2CallbackToken internal usdc;
    MockStewardToken internal stock;
    V2FixtureSettlement internal settlement;
    V2FixtureGuard internal guard;
    V2FixtureAdapter internal adapter;
    V2CallbackAdapter internal callbackAdapter;
    StewardAccountV1 internal v1;
    StewardCowV2Module internal cow;
    StewardAccountV2Prototype internal shell;

    function setUp() public {
        vm.warp(2 days + 1);
        parent = vm.addr(PARENT_KEY);
        caregiver = vm.addr(CAREGIVER_KEY);
        usdc = new V2CallbackToken();
        stock = new MockStewardToken("Stock fixture", "STK", 18);
        settlement = new V2FixtureSettlement();
        guard = new V2FixtureGuard();
        adapter = new V2FixtureAdapter();
        callbackAdapter = new V2CallbackAdapter();
        v1 = new StewardAccountV1();
        cow = new StewardCowV2Module(address(settlement), address(stock), address(guard), 500);
        address[] memory assets = new address[](1);
        assets[0] = address(stock);
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        address[] memory exceptions = new address[](2);
        exceptions[0] = vm.addr(E1);
        exceptions[1] = vm.addr(E2);
        address[] memory guardians = new address[](3);
        guardians[0] = vm.addr(G1);
        guardians[1] = vm.addr(G2);
        guardians[2] = vm.addr(G3);
        address[] memory adapters = new address[](2);
        adapters[0] = address(adapter);
        adapters[1] = address(callbackAdapter);
        address[] memory sellTokens = new address[](1);
        sellTokens[0] = address(stock);
        uint256[] memory sellCaps = new uint256[](1);
        sellCaps[0] = 500e18;
        StewardAccountV1.PolicyConfig memory config = StewardAccountV1.PolicyConfig({
            settlement: address(usdc),
            period: 1 days,
            anchor: 0,
            paymentLimit: 500e18,
            buyLimit: 500e18,
            reserve: 100e18,
            perPayment: 500e18,
            perBuy: 400e18,
            perSell: 400e18,
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
        shell = new StewardAccountV2Prototype(address(v1), address(cow), parent, config);
        v1 = StewardAccountV1(payable(address(shell)));
        usdc.mint(address(shell), 2_000e18);
        stock.mint(address(shell), 1_000e18);
        vm.prank(parent);
        v1.setDelegate(caregiver, 7, uint64(block.timestamp + 30 days), 400e18);
    }

    function _order(bool buy, uint256 sellAmount, uint256 id)
        internal
        view
        returns (StewardCowV2Module.CowOrder memory o)
    {
        o = StewardCowV2Module.CowOrder({
            sellToken: buy ? address(usdc) : address(stock),
            buyToken: buy ? address(stock) : address(usdc),
            receiver: address(shell),
            sellAmount: sellAmount,
            buyAmount: sellAmount * 95 / 100,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(id),
            feeAmount: sellAmount / 100,
            kind: cow.KIND_SELL(),
            partiallyFillable: false,
            sellTokenBalance: cow.BALANCE_ERC20(),
            buyTokenBalance: cow.BALANCE_ERC20()
        });
    }

    function _action(StewardCowV2Module.CowOrder memory o, uint256 nonce, uint256 exceptionMask)
        internal
        view
        returns (StewardAccountV1.Action memory a)
    {
        bytes32 digest = StewardCowV2Module(address(shell)).orderDigest(o);
        (,,,,,,,,,, uint256 version) = v1.policy();
        a = StewardAccountV1.Action({
            actionId: digest,
            kind: o.sellToken == address(usdc) ? 1 : 2,
            account: address(shell),
            actor: caregiver,
            chainId: block.chainid,
            securityEpoch: v1.securityEpoch(),
            policyVersion: version,
            nonce: nonce,
            tokenIn: o.sellToken,
            tokenOut: o.buyToken,
            recipient: address(shell),
            amountInRaw: o.sellAmount + o.feeAmount,
            minAmountOutRaw: o.buyAmount,
            adapter: address(settlement),
            routeHash: digest,
            validAfter: uint64(block.timestamp - 1),
            deadline: o.validTo,
            exceptionMask: exceptionMask
        });
    }

    function _sig(StewardAccountV1.Action memory a, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, v1.actionHash(a));
        return abi.encodePacked(r, s, v);
    }

    function _open(StewardCowV2Module.CowOrder memory o, uint256 nonce, uint256 exceptionMask)
        internal
        returns (bytes32 digest)
    {
        StewardAccountV1.Action memory a = _action(o, nonce, exceptionMask);
        bytes[] memory sigs = new bytes[](exceptionMask == 0 ? 1 : 3);
        sigs[0] = _sig(a, CAREGIVER_KEY);
        if (exceptionMask != 0) {
            sigs[1] = _sig(a, E1);
            sigs[2] = _sig(a, E2);
        }
        digest = StewardCowV2Module(address(shell)).openOrder(o, a, sigs);
    }

    function _v1Action(uint8 kind, uint256 amount, uint256 nonce)
        internal
        view
        returns (StewardAccountV1.Action memory a)
    {
        (,,,,,,,,,, uint256 version) = v1.policy();
        a = StewardAccountV1.Action({
            actionId: bytes32(nonce + 1_000),
            kind: kind,
            account: address(shell),
            actor: caregiver,
            chainId: block.chainid,
            securityEpoch: v1.securityEpoch(),
            policyVersion: version,
            nonce: nonce,
            tokenIn: address(usdc),
            tokenOut: kind == 0 ? address(0) : address(stock),
            recipient: kind == 0 ? recipient : address(shell),
            amountInRaw: amount,
            minAmountOutRaw: kind == 0 ? 0 : amount * 95 / 100,
            adapter: kind == 0 ? address(0) : address(adapter),
            routeHash: kind == 0 ? bytes32(0) : adapter.ROUTE(),
            validAfter: uint64(block.timestamp - 1),
            deadline: uint64(block.timestamp + 1 hours),
            exceptionMask: 0
        });
    }

    function _v1Sell(uint256 amount, uint256 nonce) internal view returns (StewardAccountV1.Action memory a) {
        a = _v1Action(2, amount, nonce);
        a.tokenIn = address(stock);
        a.tokenOut = address(usdc);
    }

    function _oneSig(StewardAccountV1.Action memory a) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](1);
        sigs[0] = _sig(a, CAREGIVER_KEY);
    }

    function _cowOpenPayload(StewardCowV2Module.CowOrder memory o, uint256 nonce) internal view returns (bytes memory) {
        StewardAccountV1.Action memory a = _action(o, nonce, 0);
        return abi.encodeCall(StewardCowV2Module.openOrder, (o, a, _oneSig(a)));
    }

    function _paymentPayload(uint256 amount, uint256 nonce) internal view returns (bytes memory) {
        StewardAccountV1.Action memory a = _v1Action(0, amount, nonce);
        return abi.encodeCall(StewardAccountV1.executePayment, (a, _oneSig(a)));
    }

    function testSharedGuardAndV1Eip712SlotsSurviveCowMutation() public {
        assertEq(vm.load(address(shell), bytes32(uint256(0))), bytes32(0));
        assertEq(vm.load(address(shell), bytes32(uint256(1))), bytes32(0));
        bytes32 id = _open(_order(true, 100e18, 70), 70, 0);
        assertEq(vm.load(address(shell), bytes32(uint256(0))), bytes32(0));
        assertEq(vm.load(address(shell), bytes32(uint256(1))), bytes32(0));
        assertEq(vm.load(address(shell), bytes32(uint256(2))), bytes32(uint256(1)));
        vm.prank(parent);
        StewardCowV2Module(address(shell)).cancelOrder(id);
        assertEq(vm.load(address(shell), bytes32(uint256(2))), bytes32(uint256(1)));
        StewardAccountV1.Action memory payment = _v1Action(0, 1e18, 71);
        v1.executePayment(payment, _oneSig(payment));
        assertEq(vm.load(address(shell), bytes32(uint256(0))), bytes32(0));
        assertEq(vm.load(address(shell), bytes32(uint256(1))), bytes32(0));
        assertEq(vm.load(address(shell), bytes32(uint256(2))), bytes32(uint256(1)));
    }

    function testExpiredUnfilledOrderChargesBudgetWithoutClaimingFill() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 100e18, 701);
        bytes32 digest = _open(o, 701, 0);
        uint256 period = v1.periodStart();
        uint256 beforeBalance = usdc.balanceOf(address(shell));
        bytes memory uid = StewardCowV2Module(address(shell)).orderUid(digest, o.validTo);
        assertEq(settlement.filledAmount(uid), 0);
        vm.warp(uint256(o.validTo) + 1);
        StewardCowV2Module(address(shell)).reconcile(digest);
        StewardCowV2Storage.Pending memory record = StewardCowV2Module(address(shell)).pendingOrder(digest);
        assertEq(record.state, 4);
        (uint256 reservedToken, uint256 reservedPeriod, uint256 chargedPeriod) =
            StewardCowV2Module(address(shell)).budgetStatus(address(usdc), period);
        assertEq(reservedToken, 0);
        assertEq(reservedPeriod, 0);
        assertEq(chargedPeriod, 101e18);
        assertEq(usdc.balanceOf(address(shell)), beforeBalance);
        assertEq(settlement.filledAmount(uid), 0);
    }

    function testV1TradeCallbackCannotOpenCowAgainstTransientPreDebitBalance() public {
        StewardCowV2Module.CowOrder memory pending = _order(true, 100e18, 80);
        callbackAdapter.arm(address(shell), _cowOpenPayload(pending, 80));
        StewardAccountV1.Action memory trade = _v1Action(1, 100e18, 81);
        trade.adapter = address(callbackAdapter);
        trade.routeHash = callbackAdapter.ROUTE();
        v1.executeTrade(trade, _oneSig(trade));
        assertFalse(callbackAdapter.lastSuccess());
        assertEq(callbackAdapter.lastError(), StewardCowV2Module.SharedReentrancy.selector);
        assertEq(v1.buySpent(v1.periodStart()), 100e18);
        (uint256 reserved, uint256 pendingBudget, uint256 cowSpent) =
            StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 0);
        assertEq(pendingBudget, 0);
        assertEq(cowSpent, 0);
        assertEq(usdc.balanceOf(address(shell)), 1_900e18);
        assertEq(stock.balanceOf(address(shell)), 1_100e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testV1PaymentAndWithdrawCallbacksCannotOpenCow() public {
        StewardCowV2Module.CowOrder memory pending = _order(true, 100e18, 90);
        usdc.arm(address(shell), _cowOpenPayload(pending, 90), 1);
        StewardAccountV1.Action memory payment = _v1Action(0, 10e18, 91);
        v1.executePayment(payment, _oneSig(payment));
        assertFalse(usdc.lastSuccess());
        assertEq(usdc.lastError(), StewardCowV2Module.SharedReentrancy.selector);
        assertEq(v1.paymentSpent(address(usdc), v1.periodStart()), 10e18);
        assertEq(usdc.balanceOf(address(shell)), 1_990e18);
        (uint256 reserved,,) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 0);

        pending = _order(true, 100e18, 92);
        usdc.arm(address(shell), _cowOpenPayload(pending, 92), 1);
        vm.prank(parent);
        v1.withdraw(address(usdc), 10e18, parent);
        assertFalse(usdc.lastSuccess());
        assertEq(usdc.lastError(), StewardCowV2Module.SharedReentrancy.selector);
        assertEq(usdc.balanceOf(address(shell)), 1_980e18);
        (reserved,,) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 0);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testCowApprovalCancelAndReconcileCallbacksCannotSpendThroughV1() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 100e18, 100);
        usdc.arm(address(shell), _paymentPayload(10e18, 101), 2);
        bytes32 id = _open(o, 100, 0);
        assertFalse(usdc.lastSuccess());
        assertEq(usdc.lastError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(v1.paymentSpent(address(usdc), v1.periodStart()), 0);
        (uint256 reserved, uint256 pending,) =
            StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 101e18);
        assertEq(pending, 101e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 101e18);

        usdc.arm(address(shell), _paymentPayload(10e18, 102), 2);
        vm.prank(parent);
        StewardCowV2Module(address(shell)).cancelOrder(id);
        assertFalse(usdc.lastSuccess());
        assertEq(usdc.lastError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(v1.paymentSpent(address(usdc), v1.periodStart()), 0);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);

        o = _order(true, 100e18, 103);
        id = _open(o, 103, 0);
        settlement.fill(address(shell), o);
        usdc.arm(address(shell), _paymentPayload(10e18, 104), 2);
        StewardCowV2Module(address(shell)).reconcile(id);
        assertFalse(usdc.lastSuccess());
        assertEq(usdc.lastError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(v1.paymentSpent(address(usdc), v1.periodStart()), 0);
        uint256 spent;
        (reserved, pending, spent) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 0);
        assertEq(pending, 0);
        assertEq(spent, 101e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testOneCustodyAddressSharesBuyBudgetAndFunds() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 200e18, 1);
        bytes32 id = _open(o, 1, 0);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0x1626ba7e));
        (uint256 reserved, uint256 pending,) =
            StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 202e18);
        assertEq(pending, 202e18);
        StewardAccountV1.Action memory buy = _v1Action(1, 299e18, 2);
        bytes[] memory buySigs = _oneSig(buy);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.executeTrade(buy, buySigs);
        buy = _v1Action(1, 298e18, 3);
        buySigs = _oneSig(buy);
        v1.executeTrade(buy, buySigs);
        assertEq(v1.buySpent(v1.periodStart()), 298e18);
        assertEq(stock.balanceOf(address(shell)), 1_298e18);
        vm.prank(parent);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.withdraw(address(usdc), 1_601e18, parent);
        vm.prank(parent);
        v1.withdraw(address(usdc), 1_400e18, parent);
        assertEq(usdc.balanceOf(address(shell)), 302e18);
        StewardAccountV1.Action memory payment = _v1Action(0, 101e18, 4);
        bytes[] memory paymentSigs = _oneSig(payment);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.executePayment(payment, paymentSigs);
        settlement.fill(address(shell), o);
        StewardCowV2Module(address(shell)).reconcile(id);
        uint256 spent;
        (reserved, pending, spent) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), v1.periodStart());
        assertEq(reserved, 0);
        assertEq(pending, 0);
        assertEq(spent, 202e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testSellReservationAndNonceCannotBeBypassedByV1() public {
        StewardCowV2Module.CowOrder memory o = _order(false, 200e18, 5);
        bytes32 id = _open(o, 5, 0);
        StewardAccountV1.Action memory buy = _v1Action(1, 1e18, 5);
        bytes[] memory buySigs = _oneSig(buy);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.executeTrade(buy, buySigs);
        buy = _v1Action(1, 1e18, 6);
        buy.actionId = id;
        buySigs = _oneSig(buy);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.executeTrade(buy, buySigs);
        StewardAccountV1.Action memory sell = _v1Sell(299e18, 7);
        bytes[] memory sellSigs = _oneSig(sell);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.executeTrade(sell, sellSigs);
        sell = _v1Sell(298e18, 8);
        sellSigs = _oneSig(sell);
        v1.executeTrade(sell, sellSigs);
        assertEq(v1.sellSpent(address(stock), v1.periodStart()), 298e18);
        vm.prank(parent);
        vm.expectRevert(StewardAccountV2Prototype.ReservedFunds.selector);
        v1.withdraw(address(stock), 501e18, parent);
        vm.prank(parent);
        v1.withdraw(address(stock), 500e18, parent);
        settlement.fill(address(shell), o);
        StewardCowV2Module(address(shell)).reconcile(id);
        assertEq(stock.allowance(address(shell), address(settlement.relayer())), 0);
        (,, uint256 spent) = StewardCowV2Module(address(shell)).budgetStatus(address(stock), v1.periodStart());
        assertEq(spent, 202e18);
    }

    function testRevocationRecoveryAndSuccessionStopCoWSignature() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 100e18, 10);
        bytes32 id = _open(o, 10, 0);
        vm.prank(parent);
        v1.revokeDelegate(caregiver);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
        vm.prank(parent);
        v1.setDelegate(caregiver, 7, uint64(block.timestamp + 30 days), 400e18);
        o = _order(true, 100e18, 11);
        id = _open(o, 11, 0);
        vm.prank(vm.addr(G1));
        v1.startRecovery(vm.addr(0x999));
        (,,, uint256 recoveryId,,) = v1.recovery();
        vm.prank(vm.addr(G2));
        v1.approveRecovery(recoveryId);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
        vm.prank(parent);
        v1.cancelRecovery();
        o = _order(true, 100e18, 12);
        id = _open(o, 12, 0);
        vm.prank(parent);
        v1.requestSuccession(
            vm.addr(0xFACE),
            vm.addr(0xABCD),
            bytes32(uint256(42)),
            bytes32(uint256(77)),
            uint64(block.timestamp + 20 days)
        );
        (,,,,,, uint256 successionId,,) = v1.succession();
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(0xABCD, v1.successionApprovalHash(successionId));
        bytes memory reviewerSig = abi.encodePacked(sr, ss, sv);
        vm.prank(vm.addr(G1));
        v1.approveSuccession(successionId, reviewerSig);
        vm.prank(vm.addr(G2));
        v1.approveSuccession(successionId, reviewerSig);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
    }

    function testDelegatedPauseAndCompletedRecoveryRotateAuthorityOverPendingOrder() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 100e18, 120);
        bytes32 id = _open(o, 120, 0);
        uint256 oldPeriod = v1.periodStart();
        vm.prank(parent);
        v1.pauseDelegatedSpending();
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        vm.prank(parent);
        v1.unpauseDelegatedSpending();
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);

        o = _order(true, 100e18, 121);
        id = _open(o, 121, 0);
        vm.prank(vm.addr(G1));
        v1.startRecovery(vm.addr(0x999));
        (, uint64 readyAt,, uint256 recoveryId,,) = v1.recovery();
        vm.prank(vm.addr(G2));
        v1.approveRecovery(recoveryId);
        (, readyAt,,,,) = v1.recovery();
        vm.warp(readyAt);
        v1.executeRecovery();
        assertEq(v1.parent(), vm.addr(0x999));
        assertEq(v1.securityEpoch(), 2);
        StewardCowV2Storage.Pending memory pending = StewardCowV2Module(address(shell)).pendingOrder(id);
        assertEq(pending.securityEpoch, 1);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
        (,, uint256 spent) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), oldPeriod);
        assertEq(spent, 101e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testCompletedSuccessionRotatesAuthorityOverPendingOrder() public {
        StewardCowV2Module.CowOrder memory o = _order(true, 100e18, 130);
        bytes32 id = _open(o, 130, 0);
        uint256 oldPeriod = v1.periodStart();
        bytes32 plan = bytes32(uint256(42));
        bytes32 evidence = bytes32(uint256(77));
        vm.prank(parent);
        v1.requestSuccession(vm.addr(0xFACE), vm.addr(0xABCD), plan, evidence, uint64(block.timestamp + 20 days));
        (,,,,,, uint256 successionId,,) = v1.succession();
        (uint8 reviewV, bytes32 reviewR, bytes32 reviewS) = vm.sign(0xABCD, v1.successionApprovalHash(successionId));
        bytes memory reviewSig = abi.encodePacked(reviewR, reviewS, reviewV);
        vm.prank(vm.addr(G1));
        v1.approveSuccession(successionId, reviewSig);
        vm.prank(vm.addr(G2));
        v1.approveSuccession(successionId, reviewSig);
        (uint8 acceptV, bytes32 acceptR, bytes32 acceptS) = vm.sign(0xFACE, v1.successionAcceptanceHash(successionId));
        vm.prank(vm.addr(0xFACE));
        v1.acceptSuccession(successionId, abi.encodePacked(acceptR, acceptS, acceptV));
        (,,,,, uint64 challengeEnds,,,) = v1.succession();
        vm.warp(challengeEnds);
        v1.executeSuccession(successionId, plan, evidence);
        assertEq(v1.parent(), vm.addr(0xFACE));
        assertEq(v1.securityEpoch(), 2);
        assertTrue(v1.delegatedSpendingPaused());
        StewardCowV2Storage.Pending memory pending = StewardCowV2Module(address(shell)).pendingOrder(id);
        assertEq(pending.securityEpoch, 1);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
        (,, uint256 spent) = StewardCowV2Module(address(shell)).budgetStatus(address(usdc), oldPeriod);
        assertEq(spent, 101e18);
        assertEq(usdc.allowance(address(shell), address(settlement.relayer())), 0);
    }

    function testExactExceptionQuorumAndActionDeadline() public {
        vm.prank(parent);
        v1.setDelegate(caregiver, 7, uint64(block.timestamp + 30 days), 100e18);
        StewardCowV2Module.CowOrder memory o = _order(true, 200e18, 20);
        StewardAccountV1.Action memory a = _action(o, 20, 0);
        bytes[] memory actorSig = _oneSig(a);
        vm.expectRevert(StewardCowV2Module.Unauthorized.selector);
        StewardCowV2Module(address(shell)).openOrder(o, a, actorSig);
        a = _action(o, 20, 6);
        bytes[] memory insufficient = new bytes[](2);
        insufficient[0] = _sig(a, CAREGIVER_KEY);
        insufficient[1] = _sig(a, E1);
        vm.expectRevert(StewardCowV2Module.BadApprovals.selector);
        StewardCowV2Module(address(shell)).openOrder(o, a, insufficient);
        bytes32 id = _open(o, 20, 6);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0x1626ba7e));
        vm.warp(uint256(o.validTo) + 1);
        assertEq(uint32(StewardCowV2Module(address(shell)).isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        StewardCowV2Module(address(shell)).reconcile(id);
    }
}
