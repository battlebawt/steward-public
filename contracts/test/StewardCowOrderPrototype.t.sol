// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockStewardToken} from "../src/mocks/MockStewardToken.sol";
import {
    StewardCowOrderAccountPrototype,
    ICowSettlementPrototype,
    IPriceGuardPrototype,
    IImmediateBuyPrototype
} from "../src/prototypes/StewardCowOrderAccountPrototype.sol";

contract PrototypeRelayer {
    address public immutable settlement;

    constructor(address settlement_) {
        settlement = settlement_;
    }

    function pull(address token, address owner, uint256 amount) external {
        require(msg.sender == settlement, "settlement only");
        require(IERC20(token).transferFrom(owner, settlement, amount), "pull failed");
    }
}

contract PrototypeSettlement is ICowSettlementPrototype {
    mapping(bytes => uint256) public filledAmount;
    PrototypeRelayer public immutable relayer;
    bytes32 public immutable domainSeparator;

    constructor() {
        relayer = new PrototypeRelayer(address(this));
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

    function fill(StewardCowOrderAccountPrototype account, StewardCowOrderAccountPrototype.CowOrder memory o) external {
        bytes32 digest = account.orderDigest(o);
        bytes memory uid = account.orderUid(digest, o.validTo);
        require(filledAmount[uid] == 0, "already filled");
        require(account.isValidSignature(digest, abi.encode(digest)) == 0x1626ba7e, "invalid 1271");
        relayer.pull(o.sellToken, address(account), o.sellAmount + o.feeAmount);
        MockStewardToken(o.buyToken).mint(o.receiver, o.buyAmount);
        filledAmount[uid] = o.sellAmount;
    }

    function setPartial(bytes calldata uid, uint256 amount) external {
        filledAmount[uid] = amount;
    }

    function clearExpired(bytes calldata uid, uint32 validTo) external {
        require(block.timestamp > validTo, "still valid");
        filledAmount[uid] = 0;
    }
}

contract PrototypePriceGuard is IPriceGuardPrototype {
    bool public live = true;

    function setLive(bool value) external {
        live = value;
    }

    function minimumOut(address, address, uint256 amount) external view returns (uint256) {
        require(live, "stale feed");
        return amount * 95 / 100;
    }
}

contract PrototypeImmediateAdapter is IImmediateBuyPrototype {
    function swapExactInput(address sellToken, address buyToken, uint256 amountIn, uint256 minOut, address receiver)
        external
        returns (uint256)
    {
        require(amountIn >= minOut, "low output");
        require(IERC20(sellToken).transferFrom(msg.sender, address(this), amountIn), "input failed");
        MockStewardToken(buyToken).mint(receiver, amountIn);
        return amountIn;
    }
}

contract StewardCowOrderPrototypeTest is Test {
    uint256 internal constant PARENT_KEY = 0xA11CE;
    uint256 internal constant CAREGIVER_KEY = 0xB0B;
    uint256 internal constant COSIGNER1_KEY = 0xC01;
    uint256 internal constant COSIGNER2_KEY = 0xC02;
    address internal parent;
    address internal caregiver;
    MockStewardToken internal usdc;
    MockStewardToken internal stock;
    PrototypeSettlement internal settlement;
    PrototypePriceGuard internal guard;
    PrototypeImmediateAdapter internal adapter;
    StewardCowOrderAccountPrototype internal account;

    function setUp() public {
        vm.warp(2 days + 1);
        parent = vm.addr(PARENT_KEY);
        caregiver = vm.addr(CAREGIVER_KEY);
        usdc = new MockStewardToken("USDC fixture", "USDC", 18);
        stock = new MockStewardToken("AAPLx fixture", "AAPLx", 18);
        settlement = new PrototypeSettlement();
        guard = new PrototypePriceGuard();
        adapter = new PrototypeImmediateAdapter();
        address[2] memory signers = [vm.addr(COSIGNER1_KEY), vm.addr(COSIGNER2_KEY)];
        uint256[6] memory limits = [uint256(200e18), 300e18, 100e18, 200e18, 300e18, 500];
        account = new StewardCowOrderAccountPrototype(
            parent,
            address(settlement),
            address(settlement.relayer()),
            address(usdc),
            address(stock),
            address(adapter),
            address(guard),
            caregiver,
            signers,
            limits
        );
        usdc.mint(address(account), 1_000e18);
        stock.mint(address(account), 1_000e18);
    }

    function _order(bool buy, uint256 amount, uint256 id)
        internal
        view
        returns (StewardCowOrderAccountPrototype.CowOrder memory)
    {
        return StewardCowOrderAccountPrototype.CowOrder({
            sellToken: buy ? address(usdc) : address(stock),
            buyToken: buy ? address(stock) : address(usdc),
            receiver: address(account),
            sellAmount: amount,
            buyAmount: amount * 95 / 100,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(id),
            feeAmount: amount / 100,
            kind: account.KIND_SELL(),
            partiallyFillable: false,
            sellTokenBalance: account.BALANCE_ERC20(),
            buyTokenBalance: account.BALANCE_ERC20()
        });
    }

    function _sig(uint256 key, bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _approval(uint256 key, bytes32 digest)
        internal
        view
        returns (StewardCowOrderAccountPrototype.Approval memory)
    {
        return StewardCowOrderAccountPrototype.Approval(vm.addr(key), _sig(key, digest));
    }

    function _approvals(bytes32 digest, uint256 mask)
        internal
        view
        returns (StewardCowOrderAccountPrototype.Approval[] memory a)
    {
        a = new StewardCowOrderAccountPrototype.Approval[](mask == 3 ? 3 : 1);
        a[0] = _approval(CAREGIVER_KEY, digest);
        if (mask == 3) {
            a[1] = _approval(COSIGNER1_KEY, digest);
            a[2] = _approval(COSIGNER2_KEY, digest);
        }
    }

    function _open(StewardCowOrderAccountPrototype.CowOrder memory o, uint256 nonce, uint256 mask)
        internal
        returns (bytes32)
    {
        bytes32 digest = account.orderDigest(o);
        return account.openOrder(
            o, caregiver, nonce, mask, _approvals(account.openDigest(digest, caregiver, nonce, mask), mask)
        );
    }

    function _expectOpenRevert(
        StewardCowOrderAccountPrototype.CowOrder memory o,
        uint256 nonce,
        uint256 mask,
        bytes4 selector
    ) internal {
        bytes32 digest = account.orderDigest(o);
        StewardCowOrderAccountPrototype.Approval[] memory approvals =
            _approvals(account.openDigest(digest, caregiver, nonce, mask), mask);
        vm.expectRevert(selector);
        account.openOrder(o, caregiver, nonce, mask, approvals);
    }

    function testBuyAndSellFullFillWithExactAccounting() public {
        StewardCowOrderAccountPrototype.CowOrder memory buy = _order(true, 100e18, 1);
        bytes32 buyId = _open(buy, 1, 0);
        assertEq(usdc.allowance(address(account), address(settlement.relayer())), 101e18);
        assertEq(usdc.allowance(address(account), address(settlement)), 0);
        assertEq(account.buyReserved(account.periodStart()), 101e18);
        assertEq(uint32(account.isValidSignature(buyId, abi.encode(buyId))), uint32(0x1626ba7e));
        uint256 usdcBefore = usdc.balanceOf(address(account));
        uint256 stockBefore = stock.balanceOf(address(account));
        settlement.fill(account, buy);
        assertEq(usdcBefore - usdc.balanceOf(address(account)), 101e18);
        assertEq(stock.balanceOf(address(account)) - stockBefore, 95e18);
        assertEq(uint32(account.isValidSignature(buyId, abi.encode(buyId))), uint32(0xffffffff));
        account.reconcile(buyId);
        assertEq(account.buyReserved(account.periodStart()), 0);
        assertEq(account.buySpent(account.periodStart()), 101e18);
        assertEq(usdc.allowance(address(account), address(settlement.relayer())), 0);
        vm.expectRevert(bytes("already filled"));
        settlement.fill(account, buy);

        StewardCowOrderAccountPrototype.CowOrder memory sell = _order(false, 100e18, 2);
        bytes32 sellId = _open(sell, 2, 0);
        uint256 stockBeforeSell = stock.balanceOf(address(account));
        uint256 usdcBeforeSell = usdc.balanceOf(address(account));
        settlement.fill(account, sell);
        account.reconcile(sellId);
        assertEq(stockBeforeSell - stock.balanceOf(address(account)), 101e18);
        assertEq(usdc.balanceOf(address(account)) - usdcBeforeSell, 95e18);
        assertEq(account.sellSpent(account.periodStart()), 101e18);
        assertEq(stock.allowance(address(account), address(settlement.relayer())), 0);
    }

    function testPendingOrdersAndImmediateBuyShareBudgetAndLiquidity() public {
        _open(_order(true, 100e18, 1), 1, 0);
        _open(_order(true, 100e18, 2), 2, 0);
        assertEq(account.buyReserved(account.periodStart()), 202e18);
        bytes32 tooMuch = account.immediateDigest(caregiver, 99e18, 95e18, 3);
        vm.expectRevert(StewardCowOrderAccountPrototype.Limit.selector);
        account.executeImmediateBuy(caregiver, 99e18, 95e18, 3, _approvals(tooMuch, 0));
        bytes32 justEnough = account.immediateDigest(caregiver, 98e18, 95e18, 3);
        account.executeImmediateBuy(caregiver, 98e18, 95e18, 3, _approvals(justEnough, 0));
        assertEq(account.buyReserved(account.periodStart()) + account.buySpent(account.periodStart()), 300e18);
        _expectOpenRevert(_order(true, 1e18, 4), 4, 0, StewardCowOrderAccountPrototype.Limit.selector);
        vm.prank(parent);
        vm.expectRevert(StewardCowOrderAccountPrototype.Limit.selector);
        account.withdraw(address(usdc), 603e18); // 100 reserve + 202 pending remain locked.
    }

    function testExceptionNeedsTwoExactCosignersAndBindsOrderFields() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 250e18, 1);
        bytes32 digest = account.orderDigest(o);
        bytes32 approvalDigest = account.openDigest(digest, caregiver, 1, 3);
        StewardCowOrderAccountPrototype.Approval[] memory one = new StewardCowOrderAccountPrototype.Approval[](2);
        one[0] = _approval(CAREGIVER_KEY, approvalDigest);
        one[1] = _approval(COSIGNER1_KEY, approvalDigest);
        vm.expectRevert(StewardCowOrderAccountPrototype.InvalidApprovals.selector);
        account.openOrder(o, caregiver, 1, 3, one);
        bytes32 id = _open(o, 1, 3);
        assertEq(account.buyReserved(account.periodStart()), 252.5e18);
        StewardCowOrderAccountPrototype.CowOrder memory changed = o;
        changed.receiver = parent;
        vm.expectRevert(StewardCowOrderAccountPrototype.InvalidOrder.selector);
        account.openOrder(changed, caregiver, 2, 3, _approvals(approvalDigest, 3));
        assertEq(uint32(account.isValidSignature(id, abi.encode(bytes32(uint256(3))))), uint32(0xffffffff));
        changed = o;
        changed.appData = bytes32(uint256(999));
        assertEq(uint32(account.isValidSignature(account.orderDigest(changed), abi.encode(id))), uint32(0xffffffff));
        _expectOpenRevert(o, 1, 3, StewardCowOrderAccountPrototype.InvalidOrder.selector); // replay cannot reserve again.
    }

    function testTwoPendingSellsCannotOvercommitCapOrStock() public {
        _open(_order(false, 100e18, 1), 1, 0);
        _open(_order(false, 190e18, 2), 2, 0);
        assertEq(account.sellReserved(account.periodStart()), 292.9e18);
        _expectOpenRevert(_order(false, 10e18, 3), 3, 0, StewardCowOrderAccountPrototype.Limit.selector);
        vm.prank(parent);
        vm.expectRevert(StewardCowOrderAccountPrototype.Limit.selector);
        account.withdraw(address(stock), 710e18);
    }

    function testNaturalCaregiverExpiryInvalidatesPendingOrder() public {
        vm.prank(parent);
        account.setCaregiver(caregiver, uint64(block.timestamp + 100));
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 100e18, 1);
        bytes32 id = _open(o, 1, 0);
        vm.warp(block.timestamp + 101);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        account.reconcile(id);
        assertEq(account.buyReserved(account.periodStart()), 0);
        assertEq(usdc.allowance(address(account), address(settlement.relayer())), 0);
    }

    function testOrderExpiresBeforeDailyRollover() public {
        uint64 oldPeriod = account.periodStart();
        uint256 boundary = uint256(oldPeriod) + account.PERIOD();
        vm.warp(boundary - 2);
        StewardCowOrderAccountPrototype.CowOrder memory forbidden = _order(true, 100e18, 1);
        forbidden.validTo = uint32(boundary);
        _expectOpenRevert(forbidden, 1, 0, StewardCowOrderAccountPrototype.InvalidOrder.selector);

        StewardCowOrderAccountPrototype.CowOrder memory allowed = _order(true, 100e18, 2);
        allowed.validTo = uint32(boundary - 1);
        bytes32 id = _open(allowed, 2, 0);
        vm.warp(boundary - 1);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0x1626ba7e));
        vm.warp(boundary);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        account.reconcile(id);
        assertEq(account.buySpent(oldPeriod), 101e18);
        assertEq(account.buySpent(account.periodStart()), 0);
        assertEq(account.buyReserved(account.periodStart()), 0);
        _open(_order(true, 190e18, 3), 3, 0);
        assertEq(account.buyReserved(account.periodStart()), 191.9e18);
    }

    function testClearedCowFillRecordCannotReleaseExpiredBudget() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 100e18, 1);
        bytes32 id = _open(o, 1, 0);
        settlement.fill(account, o);
        vm.warp(o.validTo + 1);
        settlement.clearExpired(account.orderUid(id, o.validTo), o.validTo);
        account.reconcile(id);
        assertEq(account.buyReserved(account.periodStart()), 0);
        assertEq(account.buySpent(account.periodStart()), 101e18);
        (,,,,,,,,,,, uint8 state) = account.orders(id);
        assertEq(state, 4);
    }

    function testCancelExpiryRevokeAndPolicyChangeInvalidateWithoutReleasingFill() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 100e18, 1);
        bytes32 id = _open(o, 1, 0);
        vm.prank(parent);
        account.cancelOrder(id);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        assertEq(account.buyReserved(account.periodStart()), 0);
        assertEq(usdc.allowance(address(account), address(settlement.relayer())), 0);
        vm.expectRevert(bytes("invalid 1271"));
        settlement.fill(account, o);

        o = _order(true, 100e18, 2);
        id = _open(o, 2, 0);
        settlement.fill(account, o);
        vm.prank(parent);
        account.revokeCaregiver();
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        vm.prank(parent);
        account.cancelOrder(id); // fill won the race; budget must remain spent.
        assertEq(account.buySpent(account.periodStart()), 101e18);
        assertEq(account.buyReserved(account.periodStart()), 0);

        vm.prank(parent);
        account.setCaregiver(caregiver, uint64(block.timestamp + 1 days));
        o = _order(false, 100e18, 3);
        id = _open(o, 3, 0);
        uint256[6] memory next = [uint256(200e18), 300e18, 100e18, 200e18, 300e18, 500];
        vm.prank(parent);
        account.setLimits(next);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        account.reconcile(id);
        assertEq(account.sellReserved(account.periodStart()), 0);
        assertEq(stock.allowance(address(account), address(settlement.relayer())), 0);

        o = _order(true, 100e18, 4);
        id = _open(o, 4, 0);
        vm.warp(o.validTo + 1);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        account.reconcile(id);
        assertEq(account.buyReserved(account.periodStart()), 0);
        assertEq(account.buySpent(account.periodStart()), 202e18); // Expired zero fill record is ambiguous.
    }

    function testStalePricePartialFillAndWrongDomainFailClosed() public {
        StewardCowOrderAccountPrototype.CowOrder memory o = _order(true, 100e18, 1);
        o.partiallyFillable = true;
        _expectOpenRevert(o, 1, 0, StewardCowOrderAccountPrototype.InvalidOrder.selector);
        o.partiallyFillable = false;
        o.buyAmount = 94e18;
        _expectOpenRevert(o, 1, 0, StewardCowOrderAccountPrototype.Limit.selector);
        o.buyAmount = 95e18;
        bytes32 id = _open(o, 1, 0);
        guard.setLive(false);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        vm.expectRevert(bytes("invalid 1271"));
        settlement.fill(account, o);
        guard.setLive(true);
        vm.chainId(56);
        assertEq(uint32(account.isValidSignature(id, abi.encode(id))), uint32(0xffffffff));
        vm.chainId(31337);
        settlement.setPartial(account.orderUid(id, o.validTo), 50e18);
        vm.expectRevert(StewardCowOrderAccountPrototype.InvalidFill.selector);
        account.reconcile(id);
    }
}
