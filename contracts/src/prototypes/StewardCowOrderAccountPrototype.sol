// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICowSettlementPrototype {
    function domainSeparator() external view returns (bytes32);
    function vaultRelayer() external view returns (address);
    function filledAmount(bytes calldata uid) external view returns (uint256);
}

interface IPriceGuardPrototype {
    function minimumOut(address sellToken, address buyToken, uint256 sellAmount) external view returns (uint256);
}

interface IImmediateBuyPrototype {
    function swapExactInput(address sellToken, address buyToken, uint256 amountIn, uint256 minOut, address receiver)
        external
        returns (uint256);
}

/**
 * Isolated research account for a CoW ERC-1271 sell-kind order (both USDC->stock and stock->USDC).
 * It owns its tokens and a shared immediate/pending budget ledger. It is not wired to StewardFactoryV1,
 * StewardAccountV1, manifests, or the live API. Existing Steward accounts cannot opt into it.
 */
contract StewardCowOrderAccountPrototype is EIP712, ReentrancyGuard {
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

    struct Approval {
        address signer;
        bytes signature;
    }

    struct Pending {
        address actor;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 grossSell;
        uint64 periodStart;
        uint64 policyVersion;
        uint64 securityEpoch;
        uint32 validTo;
        bool isBuy;
        uint8 state; // 0 absent, 1 pending, 2 filled, 3 cancelled before expiry, 4 expired/unresolved charged
    }

    bytes32 public constant ORDER_TYPEHASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 public constant KIND_SELL = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 public constant BALANCE_ERC20 = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;
    bytes32 public constant OPEN_TYPEHASH = keccak256(
        "Open(bytes32 orderDigest,address actor,uint256 nonce,uint64 policyVersion,uint64 securityEpoch,uint256 exceptionMask)"
    );
    bytes32 public constant IMMEDIATE_TYPEHASH = keccak256(
        "ImmediateBuy(address actor,uint256 amountIn,uint256 minOut,uint256 nonce,uint64 policyVersion,uint64 securityEpoch)"
    );
    bytes4 public constant ERC1271_MAGIC = 0x1626ba7e;
    uint64 public constant PERIOD = 1 days;
    uint8 public constant MAX_PENDING = 16;

    address public immutable parent;
    address public immutable settlement;
    address public immutable relayer;
    address public immutable settlementToken;
    address public immutable stockToken;
    address public immutable immediateAdapter;
    IPriceGuardPrototype public immutable priceGuard;
    uint256 public immutable deploymentChainId;
    address[2] public exceptionSigner;

    address public caregiver;
    uint64 public caregiverExpiresAt;
    uint64 public policyVersion = 1;
    uint64 public securityEpoch = 1;
    uint256 public perBuy;
    uint256 public buyLimit;
    uint256 public settlementReserve;
    uint256 public perSell;
    uint256 public sellLimit;
    uint256 public maxFeeBps;
    uint8 public activeCount;
    bool public paused;

    mapping(address => mapping(uint256 => bool)) public usedNonce;
    mapping(bytes32 => Pending) public orders;
    mapping(address => uint256) public reservedByToken;
    mapping(uint64 => uint256) public buyReserved;
    mapping(uint64 => uint256) public buySpent;
    mapping(uint64 => uint256) public sellReserved;
    mapping(uint64 => uint256) public sellSpent;

    error Unauthorized();
    error InvalidOrder();
    error InvalidApprovals();
    error Limit();
    error NotReady();
    error InvalidFill();

    event OrderOpened(bytes32 indexed digest, address indexed actor, bool isBuy, uint256 grossSell, uint32 validTo);
    event OrderClosed(bytes32 indexed digest, uint8 state);

    constructor(
        address parent_,
        address settlement_,
        address relayer_,
        address settlementToken_,
        address stockToken_,
        address immediateAdapter_,
        address priceGuard_,
        address caregiver_,
        address[2] memory signers_,
        uint256[6] memory limits_ // perBuy, buyLimit, reserve, perSell, sellLimit, maxFeeBps
    ) EIP712("Steward CoW Prototype", "1") {
        if (
            parent_ == address(0) || settlement_ == address(0) || relayer_ == address(0)
                || settlementToken_ == address(0) || stockToken_ == address(0) || settlementToken_ == stockToken_
                || immediateAdapter_ == address(0) || priceGuard_ == address(0) || caregiver_ == address(0)
                || signers_[0] == address(0) || signers_[1] == address(0) || signers_[0] == signers_[1]
                || limits_[0] == 0 || limits_[1] == 0 || limits_[3] == 0 || limits_[4] == 0 || limits_[5] > 500
        ) revert InvalidOrder();
        parent = parent_;
        settlement = settlement_;
        relayer = relayer_;
        settlementToken = settlementToken_;
        stockToken = stockToken_;
        immediateAdapter = immediateAdapter_;
        priceGuard = IPriceGuardPrototype(priceGuard_);
        caregiver = caregiver_;
        caregiverExpiresAt = type(uint64).max;
        exceptionSigner = signers_;
        perBuy = limits_[0];
        buyLimit = limits_[1];
        settlementReserve = limits_[2];
        perSell = limits_[3];
        sellLimit = limits_[4];
        maxFeeBps = limits_[5];
        deploymentChainId = block.chainid;
        if (
            ICowSettlementPrototype(settlement_).domainSeparator() != cowDomainSeparator()
                || ICowSettlementPrototype(settlement_).vaultRelayer() != relayer_
        ) revert InvalidOrder();
    }

    function cowDomainSeparator() public view returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", cowDomainSeparator(), structHash));
    }

    function orderUid(bytes32 digest, uint32 validTo) public view returns (bytes memory) {
        return abi.encodePacked(digest, address(this), validTo);
    }

    function periodStart() public view returns (uint64) {
        return uint64(block.timestamp / PERIOD * PERIOD);
    }

    function openDigest(bytes32 digest, address actor, uint256 nonce, uint256 exceptionMask)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(OPEN_TYPEHASH, digest, actor, nonce, policyVersion, securityEpoch, exceptionMask))
        );
    }

    function immediateDigest(address actor, uint256 amountIn, uint256 minOut, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(IMMEDIATE_TYPEHASH, actor, amountIn, minOut, nonce, policyVersion, securityEpoch))
        );
    }

    function openOrder(
        CowOrder calldata o,
        address actor,
        uint256 nonce,
        uint256 exceptionMask,
        Approval[] calldata approvals
    ) external nonReentrant returns (bytes32 digest) {
        if (paused || block.chainid != deploymentChainId || activeCount >= MAX_PENDING) {
            revert NotReady();
        }
        if (
            o.receiver != address(this) || o.kind != KIND_SELL || o.partiallyFillable
                || o.sellTokenBalance != BALANCE_ERC20 || o.buyTokenBalance != BALANCE_ERC20 || o.sellAmount == 0
                || o.buyAmount == 0 || o.sellAmount > type(uint256).max - o.feeAmount
                || o.feeAmount > o.sellAmount * maxFeeBps / 10_000 || o.validTo <= block.timestamp
                || o.validTo >= periodStart() + PERIOD
        ) revert InvalidOrder();
        bool isBuy = o.sellToken == settlementToken && o.buyToken == stockToken;
        if (!isBuy && !(o.sellToken == stockToken && o.buyToken == settlementToken)) revert InvalidOrder();
        if (o.buyAmount < priceGuard.minimumOut(o.sellToken, o.buyToken, o.sellAmount)) revert Limit();
        digest = orderDigest(o);
        if (orders[digest].state != 0 || usedNonce[actor][nonce]) revert InvalidOrder();
        _authorize(actor, openDigest(digest, actor, nonce, exceptionMask), exceptionMask, approvals);
        uint256 gross = o.sellAmount + o.feeAmount;
        uint64 period = periodStart();
        if (isBuy) {
            if (exceptionMask == 0 && (gross > perBuy || buySpent[period] + buyReserved[period] + gross > buyLimit)) {
                revert Limit();
            }
            buyReserved[period] += gross;
        } else {
            if (exceptionMask == 0 && (gross > perSell || sellSpent[period] + sellReserved[period] + gross > sellLimit))
            {
                revert Limit();
            }
            sellReserved[period] += gross;
        }
        if (
            IERC20(o.sellToken).balanceOf(address(this))
                < reservedByToken[o.sellToken] + gross + (isBuy ? settlementReserve : 0)
        ) revert Limit();
        usedNonce[actor][nonce] = true;
        reservedByToken[o.sellToken] += gross;
        activeCount++;
        orders[digest] = Pending(
            actor,
            o.sellToken,
            o.buyToken,
            o.sellAmount,
            o.buyAmount,
            gross,
            period,
            policyVersion,
            securityEpoch,
            o.validTo,
            isBuy,
            1
        );
        IERC20(o.sellToken).forceApprove(relayer, reservedByToken[o.sellToken]);
        emit OrderOpened(digest, actor, isBuy, gross, o.validTo);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 32) return 0xffffffff;
        bytes32 id = abi.decode(signature, (bytes32));
        Pending memory p = orders[id];
        if (
            id != digest || p.state != 1 || paused || block.chainid != deploymentChainId
                || p.policyVersion != policyVersion || p.securityEpoch != securityEpoch || block.timestamp > p.validTo
                || !_actorCurrent(p.actor)
        ) return 0xffffffff;
        try priceGuard.minimumOut(p.sellToken, p.buyToken, p.sellAmount) returns (uint256 floor) {
            if (p.buyAmount < floor) return 0xffffffff;
        } catch {
            return 0xffffffff;
        }
        try ICowSettlementPrototype(settlement).filledAmount(orderUid(id, p.validTo)) returns (uint256 filled) {
            return filled == 0 ? ERC1271_MAGIC : bytes4(0xffffffff);
        } catch {
            return 0xffffffff;
        }
    }

    function cancelOrder(bytes32 digest) external nonReentrant {
        Pending memory p = orders[digest];
        if (p.state != 1) revert NotReady();
        if (msg.sender != parent && msg.sender != p.actor) revert Unauthorized();
        _close(digest, p, true);
    }

    function reconcile(bytes32 digest) external nonReentrant {
        Pending memory p = orders[digest];
        if (p.state != 1) revert NotReady();
        _close(digest, p, false);
    }

    function _close(bytes32 digest, Pending memory p, bool requestedCancel) internal {
        uint256 filled = ICowSettlementPrototype(settlement).filledAmount(orderUid(digest, p.validTo));
        if (filled != 0 && filled != p.sellAmount) revert InvalidFill();
        bool completed = filled == p.sellAmount;
        // CoW can clear filledAmount storage after expiry. A zero then proves nothing
        // about whether a fill happened. Charge the old period conservatively.
        bool unresolved = filled == 0 && block.timestamp > p.validTo;
        if (
            !completed && !unresolved && !requestedCancel && !paused && p.policyVersion == policyVersion
                && p.securityEpoch == securityEpoch && _actorCurrent(p.actor)
        ) revert NotReady();
        reservedByToken[p.sellToken] -= p.grossSell;
        if (p.isBuy) {
            buyReserved[p.periodStart] -= p.grossSell;
            if (completed || unresolved) buySpent[p.periodStart] += p.grossSell;
        } else {
            sellReserved[p.periodStart] -= p.grossSell;
            if (completed || unresolved) sellSpent[p.periodStart] += p.grossSell;
        }
        uint8 nextState = completed ? 2 : unresolved ? 4 : 3;
        orders[digest].state = nextState;
        activeCount--;
        IERC20(p.sellToken).forceApprove(relayer, reservedByToken[p.sellToken]);
        emit OrderClosed(digest, nextState);
    }

    function executeImmediateBuy(
        address actor,
        uint256 amountIn,
        uint256 minOut,
        uint256 nonce,
        Approval[] calldata approvals
    ) external nonReentrant returns (uint256 amountOut) {
        if (paused || block.chainid != deploymentChainId || amountIn == 0 || usedNonce[actor][nonce]) {
            revert NotReady();
        }
        _authorize(actor, immediateDigest(actor, amountIn, minOut, nonce), 0, approvals);
        uint64 period = periodStart();
        if (
            amountIn > perBuy || buySpent[period] + buyReserved[period] + amountIn > buyLimit
                || IERC20(settlementToken).balanceOf(address(this))
                    < reservedByToken[settlementToken] + settlementReserve + amountIn
                || minOut < priceGuard.minimumOut(settlementToken, stockToken, amountIn)
        ) revert Limit();
        usedNonce[actor][nonce] = true;
        buySpent[period] += amountIn;
        uint256 beforeIn = IERC20(settlementToken).balanceOf(address(this));
        uint256 beforeOut = IERC20(stockToken).balanceOf(address(this));
        IERC20(settlementToken).forceApprove(immediateAdapter, amountIn);
        uint256 reported = IImmediateBuyPrototype(immediateAdapter)
            .swapExactInput(settlementToken, stockToken, amountIn, minOut, address(this));
        IERC20(settlementToken).forceApprove(immediateAdapter, 0);
        amountOut = IERC20(stockToken).balanceOf(address(this)) - beforeOut;
        if (
            beforeIn - IERC20(settlementToken).balanceOf(address(this)) != amountIn || amountOut < minOut
                || reported != amountOut
        ) revert InvalidFill();
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (msg.sender != parent) revert Unauthorized();
        uint256 keep = reservedByToken[token] + (token == settlementToken ? settlementReserve : 0);
        if (IERC20(token).balanceOf(address(this)) < keep + amount) revert Limit();
        IERC20(token).safeTransfer(parent, amount);
    }

    function setCaregiver(address next, uint64 expiresAt) external {
        if (msg.sender != parent || next == address(0) || expiresAt <= block.timestamp) revert Unauthorized();
        caregiver = next;
        caregiverExpiresAt = expiresAt;
        policyVersion++;
    }

    function revokeCaregiver() external {
        if (msg.sender != parent) revert Unauthorized();
        caregiver = address(0);
        caregiverExpiresAt = 0;
        securityEpoch++;
    }

    function setLimits(uint256[6] calldata next) external {
        if (msg.sender != parent || next[0] == 0 || next[1] == 0 || next[3] == 0 || next[4] == 0 || next[5] > 500) {
            revert Unauthorized();
        }
        perBuy = next[0];
        buyLimit = next[1];
        settlementReserve = next[2];
        perSell = next[3];
        sellLimit = next[4];
        maxFeeBps = next[5];
        policyVersion++;
    }

    function setPaused(bool value) external {
        if (msg.sender != parent) revert Unauthorized();
        paused = value;
        if (value) policyVersion++;
    }

    function _actorCurrent(address actor) internal view returns (bool) {
        return actor == parent || (actor == caregiver && block.timestamp <= caregiverExpiresAt);
    }

    function _authorize(address actor, bytes32 digest, uint256 mask, Approval[] calldata approvals) internal view {
        if (!_actorCurrent(actor) || approvals.length == 0) revert Unauthorized();
        bool actorSigned;
        uint256 cosigned;
        uint256 seen;
        for (uint256 i; i < approvals.length; ++i) {
            address signer = approvals[i].signer;
            if (!SignatureChecker.isValidSignatureNow(signer, digest, approvals[i].signature)) {
                revert InvalidApprovals();
            }
            if (signer == actor) {
                if (actorSigned) revert InvalidApprovals();
                actorSigned = true;
                continue;
            }
            uint256 bit = signer == exceptionSigner[0] ? 1 : signer == exceptionSigner[1] ? 2 : 0;
            if (bit == 0 || (mask & bit) == 0 || (seen & bit) != 0) revert InvalidApprovals();
            seen |= bit;
            cosigned++;
        }
        if (!actorSigned || seen != mask || (mask != 0 && cosigned < 2)) revert InvalidApprovals();
    }
}
