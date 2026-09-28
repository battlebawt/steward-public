// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {StewardAccountV1} from "../StewardAccountV1.sol";
import {ICowSettlementPrototype, IPriceGuardPrototype} from "../prototypes/StewardCowOrderAccountPrototype.sol";
import {StewardCowV2Storage} from "./StewardCowV2Storage.sol";
import {IStewardV1View} from "./IStewardV1View.sol";

/// @notice Fixed delegatecall target for a new V2 account only. It shares the V1
/// policy and continuity state at the account address and uses namespaced pending
/// order storage. Never call it directly with customer funds.
contract StewardCowV2Module {
    using SafeERC20 for IERC20;

    struct CowOrder {
        address sellToken;
        address buyToken;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        bytes32 kind;
        bool partiallyFillable;
        bytes32 sellTokenBalance;
        bytes32 buyTokenBalance;
    }

    struct V1Policy {
        address settlement;
        uint64 period;
        uint64 anchor;
        uint256 paymentLimit;
        uint256 buyLimit;
        uint256 reserve;
        uint256 perPayment;
        uint256 perBuy;
        uint256 perSell;
        uint256 exceptionQuorum;
        uint256 version;
    }

    bytes32 public constant ORDER_TYPEHASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 public constant KIND_SELL = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 public constant BALANCE_ERC20 = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;
    bytes4 public constant ERC1271_MAGIC = 0x1626ba7e;
    uint8 public constant MAX_PENDING = 16;
    // StewardAccountV1 inherits EIP712, then OZ ReentrancyGuard. Its _status is
    // slot 2 (the EIP712 fallback strings occupy slots 0 and 1). This fixed
    // module has no ordinary storage and deliberately uses V1's same lock.
    uint256 private constant V1_REENTRANCY_SLOT = 2;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    address public immutable settlement;
    address public immutable relayer;
    address public immutable stockToken;
    IPriceGuardPrototype public immutable priceGuard;
    uint256 public immutable deploymentChainId;
    uint256 public immutable maxFeeBps;

    error InvalidOrder();
    error Unauthorized();
    error Limit();
    error NotReady();
    error InvalidFill();
    error BadApprovals();
    error SharedReentrancy();

    event OrderOpened(bytes32 indexed digest, address indexed actor, uint256 grossSell, uint32 validTo);
    event OrderClosed(bytes32 indexed digest, uint8 state);

    modifier sharedNonReentrant() {
        uint256 status;
        uint256 slot = V1_REENTRANCY_SLOT;
        assembly {
            status := sload(slot)
        }
        if (status == ENTERED) revert SharedReentrancy();
        assembly {
            sstore(slot, ENTERED)
        }
        _;
        assembly {
            sstore(slot, NOT_ENTERED)
        }
    }

    constructor(address settlement_, address stockToken_, address priceGuard_, uint256 maxFeeBps_) {
        if (
            settlement_.code.length == 0 || stockToken_.code.length == 0 || priceGuard_.code.length == 0
                || maxFeeBps_ > 500
        ) revert InvalidOrder();
        settlement = settlement_;
        relayer = ICowSettlementPrototype(settlement_).vaultRelayer();
        stockToken = stockToken_;
        priceGuard = IPriceGuardPrototype(priceGuard_);
        deploymentChainId = block.chainid;
        maxFeeBps = maxFeeBps_;
        if (relayer.code.length == 0 || ICowSettlementPrototype(settlement_).domainSeparator() != _cowDomain()) {
            revert InvalidOrder();
        }
    }

    function orderDigest(CowOrder memory o) public view returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", _cowDomain(), structHash));
    }

    function orderUid(bytes32 digest, uint32 validTo) public view returns (bytes memory) {
        return abi.encodePacked(digest, address(this), validTo);
    }

    function pendingOrder(bytes32 digest) external view returns (StewardCowV2Storage.Pending memory) {
        return StewardCowV2Storage.layout().orders[digest];
    }

    function budgetStatus(address token, uint256 period)
        external
        view
        returns (uint256 reservedToken, uint256 reservedPeriod, uint256 spentPeriod)
    {
        StewardCowV2Storage.Layout storage l = StewardCowV2Storage.layout();
        reservedToken = l.reservedByToken[token];
        V1Policy memory p = _policy();
        if (token == p.settlement) {
            reservedPeriod = l.buyReserved[period];
            spentPeriod = l.buySpent[period];
        } else {
            reservedPeriod = l.sellReserved[token][period];
            spentPeriod = l.sellSpent[token][period];
        }
    }

    function openOrder(CowOrder calldata o, StewardAccountV1.Action calldata a, bytes[] calldata approvals)
        external
        sharedNonReentrant
        returns (bytes32 digest)
    {
        IStewardV1View v = IStewardV1View(address(this));
        StewardCowV2Storage.Layout storage l = StewardCowV2Storage.layout();
        V1Policy memory p = _policy();
        bool isBuy = o.sellToken == p.settlement && o.buyToken == stockToken;
        if (
            (block.chainid != deploymentChainId) || l.activeCount >= MAX_PENDING || !v.approvedToken(stockToken)
                || (!isBuy && !(o.sellToken == stockToken && o.buyToken == p.settlement)) || o.receiver != address(this)
                || o.kind != KIND_SELL || o.partiallyFillable || o.sellTokenBalance != BALANCE_ERC20
                || o.buyTokenBalance != BALANCE_ERC20 || o.sellAmount == 0 || o.buyAmount == 0
                || o.sellAmount > type(uint256).max - o.feeAmount
                || o.feeAmount > Math.mulDiv(o.sellAmount, maxFeeBps, 10_000) || o.validTo <= block.timestamp
                || o.validTo >= v.periodStart() + p.period
        ) revert InvalidOrder();
        if (o.buyAmount < priceGuard.minimumOut(o.sellToken, o.buyToken, o.sellAmount)) revert Limit();
        digest = orderDigest(o);
        uint256 gross = o.sellAmount + o.feeAmount;
        if (
            a.actionId != digest || a.routeHash != digest || a.account != address(this) || a.chainId != block.chainid
                || a.securityEpoch != v.securityEpoch() || a.policyVersion != p.version || a.actor == address(0)
                || a.tokenIn != o.sellToken || a.tokenOut != o.buyToken || a.recipient != address(this)
                || a.amountInRaw != gross || a.minAmountOutRaw != o.buyAmount || a.adapter != settlement
                || a.kind != (isBuy ? 1 : 2) || a.validAfter > block.timestamp || a.deadline != o.validTo
                || a.deadline <= a.validAfter || v.cancelledAction(digest) || v.cancelledForActor(a.actor, digest)
                || v.executedAction(digest) || v.usedNonce(a.actor, a.securityEpoch, a.nonce)
                || l.usedNonce[a.actor][a.securityEpoch][a.nonce] || l.orders[digest].state != 0
        ) revert InvalidOrder();
        if (!_actorReady(v, a.actor, a.kind, gross, a.exceptionMask != 0)) revert Unauthorized();
        _authorize(v, a, approvals, p.exceptionQuorum);
        uint256 period = v.periodStart();
        if (isBuy) {
            if (
                a.exceptionMask == 0
                    && (gross > p.perBuy
                        || v.buySpent(period) + l.buySpent[period] + l.buyReserved[period] + gross > p.buyLimit)
            ) revert Limit();
            l.buyReserved[period] += gross;
        } else {
            if (
                a.exceptionMask == 0
                    && (gross > p.perSell
                        || v.sellSpent(stockToken, period) + l.sellSpent[stockToken][period]
                                + l.sellReserved[stockToken][period] + gross > v.sellLimit(stockToken))
            ) revert Limit();
            l.sellReserved[stockToken][period] += gross;
        }
        uint256 keep = l.reservedByToken[o.sellToken] + gross + (isBuy ? p.reserve : 0);
        if (IERC20(o.sellToken).balanceOf(address(this)) < keep) revert Limit();
        l.usedNonce[a.actor][a.securityEpoch][a.nonce] = true;
        l.reservedByToken[o.sellToken] += gross;
        ++l.activeCount;
        l.orders[digest] = StewardCowV2Storage.Pending(
            a.actor,
            o.sellToken,
            o.buyToken,
            o.sellAmount,
            o.buyAmount,
            gross,
            period,
            p.version,
            a.securityEpoch,
            o.validTo,
            isBuy,
            a.exceptionMask != 0,
            1
        );
        IERC20(o.sellToken).forceApprove(relayer, l.reservedByToken[o.sellToken]);
        emit OrderOpened(digest, a.actor, gross, o.validTo);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 32 || abi.decode(signature, (bytes32)) != digest) return 0xffffffff;
        StewardCowV2Storage.Pending memory o = StewardCowV2Storage.layout().orders[digest];
        if (o.state != 1 || block.chainid != deploymentChainId || block.timestamp > o.validTo) return 0xffffffff;
        IStewardV1View v = IStewardV1View(address(this));
        if (
            o.securityEpoch != v.securityEpoch() || o.policyVersion != _policy().version || v.cancelledAction(digest)
                || v.cancelledForActor(o.actor, digest) || v.executedAction(digest)
                || !_actorReady(v, o.actor, o.isBuy ? 1 : 2, o.grossSell, o.exception) || !v.approvedToken(stockToken)
        ) return 0xffffffff;
        try priceGuard.minimumOut(o.sellToken, o.buyToken, o.sellAmount) returns (uint256 floor) {
            if (o.buyAmount < floor) return 0xffffffff;
        } catch {
            return 0xffffffff;
        }
        try ICowSettlementPrototype(settlement).filledAmount(orderUid(digest, o.validTo)) returns (uint256 filled) {
            return filled == 0 ? ERC1271_MAGIC : bytes4(0xffffffff);
        } catch {
            return 0xffffffff;
        }
    }

    function cancelOrder(bytes32 digest) external sharedNonReentrant {
        StewardCowV2Storage.Pending memory o = StewardCowV2Storage.layout().orders[digest];
        if (o.state != 1) revert NotReady();
        if (msg.sender != IStewardV1View(address(this)).parent() && msg.sender != o.actor) revert Unauthorized();
        _close(digest, o, true);
    }

    function reconcile(bytes32 digest) external sharedNonReentrant {
        StewardCowV2Storage.Pending memory o = StewardCowV2Storage.layout().orders[digest];
        if (o.state != 1) revert NotReady();
        _close(digest, o, false);
    }

    function _close(bytes32 digest, StewardCowV2Storage.Pending memory o, bool requestedCancel) private {
        uint256 filled = ICowSettlementPrototype(settlement).filledAmount(orderUid(digest, o.validTo));
        if (filled != 0 && filled != o.sellAmount) revert InvalidFill();
        bool completed = filled == o.sellAmount;
        bool ambiguous = filled == 0 && block.timestamp > o.validTo;
        IStewardV1View v = IStewardV1View(address(this));
        if (
            !completed && !ambiguous && !requestedCancel && o.policyVersion == _policy().version
                && o.securityEpoch == v.securityEpoch() && !v.cancelledAction(digest)
                && !v.cancelledForActor(o.actor, digest)
                && _actorReady(v, o.actor, o.isBuy ? 1 : 2, o.grossSell, o.exception)
        ) revert NotReady();
        StewardCowV2Storage.Layout storage l = StewardCowV2Storage.layout();
        l.reservedByToken[o.sellToken] -= o.grossSell;
        if (o.isBuy) {
            l.buyReserved[o.periodStart] -= o.grossSell;
            if (completed || ambiguous) l.buySpent[o.periodStart] += o.grossSell;
        } else {
            l.sellReserved[o.sellToken][o.periodStart] -= o.grossSell;
            if (completed || ambiguous) l.sellSpent[o.sellToken][o.periodStart] += o.grossSell;
        }
        uint8 next = completed ? 2 : ambiguous ? 4 : 3;
        l.orders[digest].state = next;
        --l.activeCount;
        IERC20(o.sellToken).forceApprove(relayer, l.reservedByToken[o.sellToken]);
        emit OrderClosed(digest, next);
    }

    function _actorReady(IStewardV1View v, address actor, uint8 kind, uint256 amount, bool exception)
        private
        view
        returns (bool)
    {
        address owner = v.parent();
        if (actor != owner) {
            if (v.delegatedSpendingPaused()) return false;
            (,, uint64 recoveryExpiry,, uint256 recoveryApprovals, bool recoveryActive) = v.recovery();
            if (recoveryActive && recoveryApprovals >= 2 && block.timestamp <= recoveryExpiry) return false;
            (,,,, uint64 deadline,,,, uint8 state) = v.succession();
            if ((state == 2 || state == 3) && block.timestamp <= deadline) return false;
            (uint256 mask, uint256 perActionLimit, uint64 expiresAt, uint256 epoch, bool enabled) = v.delegates(actor);
            if (!enabled || epoch != v.securityEpoch() || expiresAt < block.timestamp || (mask & (1 << kind)) == 0) {
                return false;
            }
            // Exception-sized orders need their exact co-signatures at open. Existing
            // orders may remain above a later per-action reduction only until the
            // policy version changes, which the signature check separately enforces.
            if (perActionLimit != 0 && amount > perActionLimit && !exception) return false;
        }
        return true;
    }

    function _authorize(
        IStewardV1View v,
        StewardAccountV1.Action calldata a,
        bytes[] calldata approvals,
        uint256 quorum
    ) private view {
        if (approvals.length == 0) revert BadApprovals();
        bytes32 digest = StewardAccountV1(payable(address(this))).actionHash(a);
        address[] memory signers = v.policyAddresses(2);
        address[] memory seen = new address[](approvals.length);
        bool actorSigned;
        bool parentSigned;
        uint256 exceptionCount;
        for (uint256 i; i < approvals.length; ++i) {
            address signer = _signer(digest, approvals[i]);
            if (signer == address(0)) revert BadApprovals();
            for (uint256 j; j < i; ++j) {
                if (seen[j] == signer) revert BadApprovals();
            }
            seen[i] = signer;
            if (signer == a.actor) actorSigned = true;
            if (signer == v.parent()) parentSigned = true;
            if (signer != a.actor && a.exceptionMask > 1) {
                for (uint256 k; k < signers.length; ++k) {
                    if (signers[k] == signer) {
                        if ((a.exceptionMask & (uint256(1) << (k + 1))) == 0) revert BadApprovals();
                        ++exceptionCount;
                        break;
                    }
                }
            }
        }
        if (!actorSigned) revert BadApprovals();
        if (a.exceptionMask == 0) return;
        if (a.exceptionMask == 1) {
            if (!parentSigned) revert BadApprovals();
            return;
        }
        uint256 validBits = signers.length >= 255 ? type(uint256).max : ((uint256(1) << (signers.length + 1)) - 2);
        if ((a.exceptionMask & ~validBits) != 0) revert BadApprovals();
        uint256 maskCount;
        uint256 mask = a.exceptionMask;
        while (mask != 0) {
            maskCount += mask & 1;
            mask >>= 1;
        }
        if (maskCount != exceptionCount || exceptionCount < quorum) revert BadApprovals();
    }

    function _signer(bytes32 digest, bytes calldata sig) private view returns (address) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err == ECDSA.RecoverError.NoError) return recovered;
        if (sig.length > 32) {
            (address candidate, bytes memory inner) = abi.decode(sig, (address, bytes));
            if (SignatureChecker.isValidSignatureNow(candidate, digest, inner)) return candidate;
        }
        return address(0);
    }

    function _policy() private view returns (V1Policy memory p) {
        (
            p.settlement,
            p.period,
            p.anchor,
            p.paymentLimit,
            p.buyLimit,
            p.reserve,
            p.perPayment,
            p.perBuy,
            p.perSell,
            p.exceptionQuorum,
            p.version
        ) = IStewardV1View(address(this)).policy();
    }

    function _cowDomain() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Gnosis Protocol"),
                keccak256("v2"),
                block.chainid,
                settlement
            )
        );
    }
}
