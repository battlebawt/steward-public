// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStewardTradeAdapter} from "./interfaces/IStewardTradeAdapter.sol";

/// @notice A non-upgradeable, parent-owned bounded spending account.
///
/// All delegated actions use the same typed Action validator. There is no
/// arbitrary call, delegatecall, external target calldata, or standing token
/// allowance. Trade adapters are explicitly admitted and receive an allowance
/// for exactly one measured input amount.
contract StewardAccountV1 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    string internal constant VERSION = "STEWARD_ACCOUNT_V1";
    bytes32 internal constant ACTION_TYPEHASH = keccak256(
        "Action(bytes32 actionId,uint8 kind,address account,address actor,uint256 chainId,uint256 securityEpoch,uint256 policyVersion,uint256 nonce,address tokenIn,address tokenOut,address recipient,uint256 amountInRaw,uint256 minAmountOutRaw,address adapter,bytes32 routeHash,uint64 validAfter,uint64 deadline,uint256 exceptionMask)"
    );
    uint8 internal constant PAYMENT = 0;
    uint8 internal constant BUY = 1;
    uint8 internal constant SELL = 2;
    uint256 internal constant DAY = 1 days;
    uint64 internal constant POLICY_REVIEW_DELAY = 48 hours;
    uint64 internal constant RECOVERY_DELAY = 48 hours;
    uint64 internal constant RECOVERY_LIFETIME = 14 days;
    uint64 internal constant SUCCESSION_CHALLENGE = 14 days;

    struct Action {
        bytes32 actionId;
        uint8 kind;
        address account;
        address actor;
        uint256 chainId;
        uint256 securityEpoch;
        uint256 policyVersion;
        uint256 nonce;
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 amountInRaw;
        uint256 minAmountOutRaw;
        address adapter;
        bytes32 routeHash;
        uint64 validAfter;
        uint64 deadline;
        uint256 exceptionMask;
    }

    struct PolicyConfig {
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
        address[] approvedTokens;
        address[] paymentRecipients;
        address[] exceptionSigners;
        address[] guardians;
        address[] approvedAdapters;
        address[] sellCapTokens;
        uint256[] sellCaps;
        address continuityReviewer;
        address continuitySuccessor;
        bytes32 continuityPlanHash;
    }

    struct Delegate {
        uint256 actionMask;
        uint256 perActionLimit;
        uint64 expiresAt;
        uint256 epoch;
        bool enabled;
    }

    struct Policy {
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

    struct PendingPolicy {
        bytes32 commitment;
        uint64 readyAt;
        bool active;
    }

    struct PendingDelegate {
        address delegate;
        uint256 actionMask;
        uint256 perActionLimit;
        uint64 expiresAt;
        uint64 readyAt;
        bool active;
    }

    struct Recovery {
        address newParent;
        uint64 readyAt;
        uint64 expiresAt;
        uint256 id;
        uint256 approvals;
        bool active;
    }

    struct Succession {
        bytes32 planHash;
        bytes32 evidenceHash;
        address successor;
        address reviewer;
        uint64 deadline;
        uint64 challengeEnds;
        uint256 id;
        uint256 approvals;
        uint8 state; // 1 requested, 2 approved, 3 challenged, 4 executable, 5 executed, 6 rejected, 7 expired
    }


    address public parent;
    bool public initialized;
    Policy public policy;
    uint256 public securityEpoch = 1;
    bool public delegatedSpendingPaused;

    mapping(address => Delegate) public delegates;
    mapping(address => bool) public approvedPaymentRecipient;
    mapping(address => bool) public approvedToken;
    mapping(address => bool) public approvedGuardian;
    mapping(address => bool) public exceptionSigner;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public sellLimit;
    address[] private _guardians;
    address[] private _exceptionSigners;
    address[] private _approvedTokens;
    address[] private _paymentRecipients;
    address[] private _approvedAdapters;
    address[] private _sellCapTokens;
    bytes32 private _rolesCommitment;
    address public continuityReviewer;
    address public continuitySuccessor;
    bytes32 public continuityPlanHash;
    address public incapacityModule;
    address public incapacityCaregiver;
    uint256 public incapacityActionMask;
    uint256 public incapacityPerActionLimit;
    bool public incapacityActive;

    mapping(address => mapping(uint256 => uint256)) public paymentSpent;
    mapping(uint256 => uint256) public buySpent;
    mapping(address => mapping(uint256 => uint256)) public sellSpent;
    mapping(address => mapping(uint256 => mapping(uint256 => bool))) public usedNonce;
    mapping(bytes32 => bool) public cancelledAction;
    mapping(bytes32 => bool) public executedAction;
    mapping(address => mapping(bytes32 => bool)) public cancelledForActor;
    bool public successionAccepted;

    PendingPolicy public pendingPolicy;
    PendingDelegate public pendingDelegate;
    address public pendingAdapter;
    uint64 public pendingAdapterReadyAt;
    address private pendingIncapacityModule;
    address private pendingIncapacityCaregiver;
    uint256 private pendingIncapacityActionMask;
    uint256 private pendingIncapacityPerActionLimit;
    uint64 private pendingIncapacityReadyAt;
    Recovery public recovery;
    mapping(uint256 => mapping(address => bool)) public recoveryApproved;
    uint256 public recoveryNonce;
    Succession public succession;
    mapping(uint256 => mapping(address => bool)) public successionApproved;

    event ActionExecuted(bytes32 indexed actionId, uint8 indexed kind, address indexed actor, uint256 amountIn, uint256 amountOut);
    event ActionCancelled(bytes32 indexed actionId, address indexed by);
    event DelegateUpdated(address indexed delegate, uint256 actionMask, uint256 perActionLimit, uint64 expiresAt, bool enabled);
    event PolicyVersionChanged(uint256 indexed version);
    event PolicyExpansionQueued(bytes32 indexed commitment, uint64 readyAt);
    event PolicyExpansionCancelled(bytes32 indexed commitment);
    event DelegateExpansionQueued(address indexed delegate, uint64 readyAt);
    event AdapterAdmissionQueued(address indexed adapter, uint64 readyAt);
    event RecoveryStarted(uint256 indexed id, address indexed newParent, uint64 readyAt, uint64 expiresAt);
    event RecoveryApproved(uint256 indexed id, address indexed guardian, uint256 approvals);
    event RecoveryExecuted(uint256 indexed id, address indexed newParent, uint256 securityEpoch);
    event RecoveryCancelled(uint256 indexed id);
    event SuccessionRequested(uint256 indexed id, address indexed successor, bytes32 planHash, bytes32 evidenceHash);
    event SuccessionApproved(uint256 indexed id, address indexed guardian, uint256 approvals);
    event SuccessionChallenged(uint256 indexed id, address indexed guardian);
    event SuccessionExecuted(uint256 indexed id, address indexed successor);

    error Unauthorized();
    error InvalidAction();
    error Expired();
    error NotReady();
    error CapExceeded();
    error Unsupported();
    error AlreadyUsed();
    error BadApprovals();
    error Paused();
    error Pending();

    constructor() EIP712("Steward", "1") {}

    function initialize(address parent_, PolicyConfig calldata config) external {
        if (initialized) revert InvalidAction();
        securityEpoch = 1;
        if (parent_ == address(0) || config.settlement == address(0)) revert InvalidAction();
        if (config.period == 0 || config.period > DAY || config.exceptionQuorum == 0) revert InvalidAction();
        if (config.anchor % config.period != 0) revert InvalidAction();
        if (config.guardians.length < 3 || config.exceptionSigners.length < config.exceptionQuorum) revert InvalidAction();
        if (config.sellCapTokens.length != config.sellCaps.length) revert InvalidAction();
        parent = parent_;
        continuityReviewer = config.continuityReviewer;
        continuitySuccessor = config.continuitySuccessor;
        continuityPlanHash = config.continuityPlanHash;
        policy.settlement = config.settlement;
        policy.period = config.period;
        policy.anchor = config.anchor;
        _applyScalars(config);
        for (uint256 i; i < config.exceptionSigners.length; ++i) {
            address signer = config.exceptionSigners[i];
            if (signer == address(0) || signer == parent_ || exceptionSigner[signer]) revert InvalidAction();
            exceptionSigner[signer] = true;
            _exceptionSigners.push(signer);
        }
        for (uint256 i; i < config.guardians.length; ++i) {
            address guardian = config.guardians[i];
            if (guardian == address(0) || guardian == parent_ || approvedGuardian[guardian]) revert InvalidAction();
            approvedGuardian[guardian] = true;
            _guardians.push(guardian);
        }
        _rolesCommitment = keccak256(abi.encode(config.exceptionSigners, config.guardians));
        initialized = true;
    }

    /// @notice Returns one of the policy's address lists.
    /// @dev Adapter history is returned as stored, including revoked adapters.
    function policyAddresses(uint8 list) external view returns (address[] memory) {
        if (list == 0) return _approvedTokens;
        if (list == 1) return _paymentRecipients;
        if (list == 2) return _exceptionSigners;
        if (list == 3) return _guardians;
        if (list == 4) return _approvedAdapters;
        if (list == 5) return _sellCapTokens;
        revert InvalidAction();
    }

    receive() external payable {}

    function withdraw(address token, uint256 amount, address to) external onlyParent nonReentrant {
        if (to == address(0) || amount == 0) revert InvalidAction();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert Unsupported();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function actionHash(Action calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH, a)));
    }

    function periodStart() public view returns (uint256) {
        if (block.timestamp < policy.anchor) return policy.anchor;
        return policy.anchor + ((block.timestamp - policy.anchor) / policy.period) * policy.period;
    }

    function setDelegate(address delegate, uint256 actionMask, uint64 expiresAt, uint256 perActionLimit) external onlyParent {
        if (delegate == address(0) || delegate == parent || expiresAt <= block.timestamp) revert InvalidAction();
        // The parent may grant or change a bounded caregiver role immediately.
        // Execution remains constrained by the account policy, epoch and pause.
        delegates[delegate] = Delegate(actionMask, perActionLimit, expiresAt, securityEpoch, true);
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
        emit DelegateUpdated(delegate, actionMask, perActionLimit, expiresAt, true);
    }

    function executeDelegateExpansion() external onlyParent {
        PendingDelegate memory p = pendingDelegate;
        if (!p.active || block.timestamp < p.readyAt) revert NotReady();
        delegates[p.delegate] = Delegate(p.actionMask, p.perActionLimit, p.expiresAt, securityEpoch, true);
        delete pendingDelegate;
        ++policy.version;
        emit DelegateUpdated(p.delegate, p.actionMask, p.perActionLimit, p.expiresAt, true);
        emit PolicyVersionChanged(policy.version);
    }

    function revokeDelegate(address delegate) external onlyParent {
        if (pendingDelegate.delegate == delegate) delete pendingDelegate;
        delegates[delegate].enabled = false;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
        emit DelegateUpdated(delegate, 0, 0, 0, false);
    }

    function pauseDelegatedSpending() external onlyParent {
        delegatedSpendingPaused = true;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
    }

    function unpauseDelegatedSpending() external onlyParent {
        delegatedSpendingPaused = false;
    }

    /// @notice Queue one exact module/caregiver scope. Enrollment itself is a
    /// policy expansion and therefore receives the same review delay as other
    /// authority expansions.
    function queueIncapacityModule(address module, address caregiver, uint256 actionMask, uint256 perActionLimit) external onlyParent {
        if (module == address(0) || caregiver == address(0) || caregiver == parent || incapacityActive || actionMask == 0) revert InvalidAction();
        pendingIncapacityModule = module;
        pendingIncapacityCaregiver = caregiver;
        pendingIncapacityActionMask = actionMask;
        pendingIncapacityPerActionLimit = perActionLimit;
        pendingIncapacityReadyAt = uint64(block.timestamp + POLICY_REVIEW_DELAY);
    }

    function executeIncapacityModule() external onlyParent {
        if (pendingIncapacityModule == address(0) || block.timestamp < pendingIncapacityReadyAt) revert NotReady();
        incapacityModule = pendingIncapacityModule;
        incapacityCaregiver = pendingIncapacityCaregiver;
        incapacityActionMask = pendingIncapacityActionMask;
        incapacityPerActionLimit = pendingIncapacityPerActionLimit;
        pendingIncapacityModule = address(0);
        pendingIncapacityCaregiver = address(0);
        pendingIncapacityActionMask = 0;
        pendingIncapacityPerActionLimit = 0;
        pendingIncapacityReadyAt = 0;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
    }

    function activateIncapacity(
        address caregiver,
        uint256 actionMask,
        uint256 perActionLimit,
        uint256 requestedEpoch,
        uint64 expiresAt
    ) external {
        if (msg.sender != incapacityModule || caregiver != incapacityCaregiver || actionMask != incapacityActionMask || perActionLimit != incapacityPerActionLimit || requestedEpoch != securityEpoch || expiresAt <= block.timestamp || actionMask == 0) revert Unauthorized();
        delegates[caregiver] = Delegate(actionMask, perActionLimit, expiresAt, securityEpoch, true);
        delegatedSpendingPaused = false;
        incapacityActive = true;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
    }

    function deactivateIncapacity() external {
        if (msg.sender != incapacityModule && msg.sender != parent) revert Unauthorized();
        delegates[incapacityCaregiver].enabled = false;
        incapacityActive = false;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
    }

    function cancelAction(bytes32 actionId) external {
        if (msg.sender != parent) revert Unauthorized();
        cancelledAction[actionId] = true;
        emit ActionCancelled(actionId, msg.sender);
    }

    /// @dev A requester can cancel a not-yet-executed action by presenting its
    /// exact typed signature. This makes cancellation actor-scoped before
    /// execution.
    function cancelOwnAction(Action calldata a, bytes calldata actorSignature) external {
        if (a.actor != msg.sender || !_isValidSigner(actionHash(a), actorSignature, msg.sender)) revert Unauthorized();
        cancelledForActor[a.actor][a.actionId] = true;
        emit ActionCancelled(a.actionId, msg.sender);
    }

    function executePayment(Action calldata a, bytes[] calldata approvals) external nonReentrant returns (uint256) {
        if (a.kind != PAYMENT) revert InvalidAction();
        _validateAndConsume(a, approvals);
        if (a.tokenIn != policy.settlement || a.tokenOut != address(0) || a.adapter != address(0)) revert Unsupported();
        if (!approvedPaymentRecipient[a.recipient]) revert Unsupported();
        uint256 beforeBalance = IERC20(a.tokenIn).balanceOf(a.recipient);
        IERC20(a.tokenIn).safeTransfer(a.recipient, a.amountInRaw);
        uint256 amountOut = IERC20(a.tokenIn).balanceOf(a.recipient) - beforeBalance;
        if (amountOut != a.amountInRaw) revert Unsupported();
        emit ActionExecuted(a.actionId, a.kind, a.actor, a.amountInRaw, amountOut);
        return amountOut;
    }

    function executeTrade(Action calldata a, bytes[] calldata approvals) external nonReentrant returns (uint256) {
        if (a.kind != BUY && a.kind != SELL) revert InvalidAction();
        _validateAndConsume(a, approvals);
        if (!approvedToken[a.kind == BUY ? a.tokenOut : a.tokenIn]) revert Unsupported();
        if (a.recipient != address(this) || a.adapter == address(0) || !approvedAdapter[a.adapter]) revert Unsupported();
        if (IStewardTradeAdapter(a.adapter).routeHash(a.tokenIn, a.tokenOut) != a.routeHash) revert Unsupported();
        uint256 beforeIn = IERC20(a.tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(a.tokenOut).balanceOf(address(this));
        IERC20(a.tokenIn).forceApprove(a.adapter, a.amountInRaw);
        uint256 reported = IStewardTradeAdapter(a.adapter).swap(
            a.tokenIn, a.tokenOut, a.amountInRaw, a.minAmountOutRaw, address(this), a.routeHash
        );
        IERC20(a.tokenIn).forceApprove(a.adapter, 0);
        uint256 afterIn = IERC20(a.tokenIn).balanceOf(address(this));
        uint256 afterOut = IERC20(a.tokenOut).balanceOf(address(this));
        if (beforeIn < afterIn || beforeOut > afterOut) revert Unsupported();
        uint256 actualIn = beforeIn - afterIn;
        uint256 actualOut = afterOut - beforeOut;
        if (actualIn != a.amountInRaw || actualOut < a.minAmountOutRaw || reported != actualOut) revert Unsupported();
        emit ActionExecuted(a.actionId, a.kind, a.actor, actualIn, actualOut);
        return actualOut;
    }

    function _validateAndConsume(Action calldata a, bytes[] calldata approvals) internal {
        if ((delegatedSpendingPaused || (recovery.active && recovery.approvals >= 2 && block.timestamp <= recovery.expiresAt) || ((succession.state == 2 || succession.state == 3) && block.timestamp <= succession.deadline)) && a.actor != parent) revert Paused();
        if (a.account != address(this) || a.actor == address(0) || a.amountInRaw == 0) revert InvalidAction();
        if (a.chainId != block.chainid || a.securityEpoch != securityEpoch || a.policyVersion != policy.version) revert InvalidAction();
        if (a.validAfter > block.timestamp || a.deadline < block.timestamp || a.deadline <= a.validAfter) revert Expired();
        if (cancelledAction[a.actionId] || cancelledForActor[a.actor][a.actionId] || executedAction[a.actionId]) revert AlreadyUsed();
        if (usedNonce[a.actor][securityEpoch][a.nonce]) revert AlreadyUsed();
        bytes32 digest_ = actionHash(a);
        _authorize(a, digest_, approvals);
        uint256 start = periodStart();
        bool exception = a.exceptionMask != 0;
        if (a.kind == PAYMENT) {
            if (a.tokenIn != policy.settlement || a.tokenOut != address(0)) revert Unsupported();
            if (a.amountInRaw > policy.perPayment && !exception) revert CapExceeded();
            uint256 next = paymentSpent[policy.settlement][start] + a.amountInRaw;
            if (next > policy.paymentLimit && !exception) revert CapExceeded();
            paymentSpent[policy.settlement][start] = next;
        } else if (a.kind == BUY) {
            if (a.tokenIn != policy.settlement || a.tokenOut == address(0)) revert Unsupported();
            if (a.amountInRaw > policy.perBuy && !exception) revert CapExceeded();
            uint256 next = buySpent[start] + a.amountInRaw;
            if (next > policy.buyLimit && !exception) revert CapExceeded();
            if (IERC20(policy.settlement).balanceOf(address(this)) < policy.reserve + a.amountInRaw) revert CapExceeded();
            buySpent[start] = next;
        } else if (a.kind == SELL) {
            if (a.tokenIn == address(0) || a.tokenOut != policy.settlement) revert Unsupported();
            if (a.amountInRaw > policy.perSell && !exception) revert CapExceeded();
            uint256 cap = sellLimit[a.tokenIn];
            uint256 next = sellSpent[a.tokenIn][start] + a.amountInRaw;
            if (cap == 0 || next > cap) {
                if (!exception) revert CapExceeded();
            }
            sellSpent[a.tokenIn][start] = next;
        } else {
            revert InvalidAction();
        }
        if (a.actor != parent) {
            Delegate memory d = delegates[a.actor];
            if (!d.enabled || d.epoch != securityEpoch || d.expiresAt < block.timestamp || (d.actionMask & (1 << a.kind)) == 0) {
                revert Unauthorized();
            }
            if (d.perActionLimit != 0 && a.amountInRaw > d.perActionLimit && !exception) revert CapExceeded();
        }
        usedNonce[a.actor][securityEpoch][a.nonce] = true;
        executedAction[a.actionId] = true;
    }

    function _authorize(Action calldata a, bytes32 digest_, bytes[] calldata approvals) internal view {
        if (approvals.length == 0) revert BadApprovals();
        bool actorSigned;
        bool parentSigned;
        uint256 exceptionCount;
        address[] memory seen = new address[](approvals.length);
        for (uint256 i; i < approvals.length; ++i) {
            address signer = _signer(digest_, approvals[i]);
            if (signer == address(0)) revert BadApprovals();
            for (uint256 j; j < i; ++j) if (seen[j] == signer) revert BadApprovals();
            seen[i] = signer;
            if (signer == a.actor) actorSigned = true;
            if (signer == parent) parentSigned = true;
            if (exceptionSigner[signer] && signer != a.actor && a.exceptionMask > 1) {
                uint256 signerIndex = _exceptionIndex(signer);
                if ((a.exceptionMask & (uint256(1) << (signerIndex + 1))) == 0) revert BadApprovals();
                ++exceptionCount;
            }
        }
        if (!actorSigned && !(a.actor == parent && parentSigned)) revert BadApprovals();
        if (a.exceptionMask == 0) return;
        if ((a.exceptionMask & 1) != 0) {
            if (a.exceptionMask != 1) revert BadApprovals();
            if (!parentSigned) revert BadApprovals();
            return;
        }
        uint256 validBits = _exceptionSigners.length >= 255 ? type(uint256).max : ((uint256(1) << (_exceptionSigners.length + 1)) - 2);
        if ((a.exceptionMask & ~validBits) != 0) revert BadApprovals();
        uint256 maskCount;
        uint256 mask = a.exceptionMask;
        while (mask != 0) { maskCount += mask & 1; mask >>= 1; }
        if (maskCount != exceptionCount) revert BadApprovals();
        if (exceptionCount < policy.exceptionQuorum) revert BadApprovals();
    }

    function _exceptionIndex(address signer) internal view returns (uint256) {
        for (uint256 i; i < _exceptionSigners.length; ++i) if (_exceptionSigners[i] == signer) return i;
        revert BadApprovals();
    }

    function _isValidSigner(bytes32 digest_, bytes calldata sig, address expected) internal view returns (bool) {
        return _signer(digest_, sig) == expected;
    }

    function _signer(bytes32 digest_, bytes calldata sig) internal view returns (address) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest_, sig);
        if (err == ECDSA.RecoverError.NoError) return recovered;
        // ERC-1271 signatures are accepted only when the supplied signature
        // is accompanied by an address-shaped envelope: abi.encode(address,bytes).
        if (sig.length > 32) {
            (address candidate, bytes memory inner) = abi.decode(sig, (address, bytes));
            if (SignatureChecker.isValidSignatureNow(candidate, digest_, inner)) return candidate;
        }
        return address(0);
    }

    function tightenPolicy(PolicyConfig calldata next) external onlyParent {
        if (next.settlement != policy.settlement || next.period != policy.period || next.anchor != policy.anchor) revert InvalidAction();
        if (next.paymentLimit > policy.paymentLimit || next.buyLimit > policy.buyLimit || next.reserve < policy.reserve) revert InvalidAction();
        if (next.perPayment > policy.perPayment || next.perBuy > policy.perBuy || next.perSell > policy.perSell) revert InvalidAction();
        if (next.exceptionQuorum < policy.exceptionQuorum) revert InvalidAction();
        for (uint256 i; i < next.approvedTokens.length; ++i) if (!approvedToken[next.approvedTokens[i]]) revert InvalidAction();
        for (uint256 i; i < next.paymentRecipients.length; ++i) if (!approvedPaymentRecipient[next.paymentRecipients[i]]) revert InvalidAction();
        for (uint256 i; i < next.approvedAdapters.length; ++i) if (!approvedAdapter[next.approvedAdapters[i]]) revert InvalidAction();
        if (next.sellCapTokens.length != next.sellCaps.length) revert InvalidAction();
        for (uint256 i; i < next.sellCapTokens.length; ++i) if (next.sellCaps[i] > sellLimit[next.sellCapTokens[i]]) revert InvalidAction();
        _applyScalars(next);
        emit PolicyVersionChanged(policy.version);
    }

    function queuePolicyExpansion(bytes32 commitment) external onlyParent {
        if (commitment == bytes32(0)) revert InvalidAction();
        pendingPolicy = PendingPolicy(commitment, uint64(block.timestamp + POLICY_REVIEW_DELAY), true);
        emit PolicyExpansionQueued(commitment, pendingPolicy.readyAt);
    }

    function cancelPolicyExpansion() external {
        if (msg.sender != parent && !exceptionSigner[msg.sender]) revert Unauthorized();
        bytes32 hash = pendingPolicy.commitment;
        _clearPending();
        emit PolicyExpansionCancelled(hash);
    }

    function executePolicyExpansion(PolicyConfig calldata next, bytes32 salt) external onlyParent {
        if (!pendingPolicy.active || block.timestamp < pendingPolicy.readyAt) revert NotReady();
        if (keccak256(abi.encode(next, salt)) != pendingPolicy.commitment) revert InvalidAction();
        if (next.settlement != policy.settlement || next.period != policy.period || next.anchor != policy.anchor) revert InvalidAction();
        _applyScalars(next);
        delete pendingPolicy;
        emit PolicyVersionChanged(policy.version);
    }

    function _applyScalars(PolicyConfig calldata next) internal {
        if (initialized) _requireUnchangedRoles(next);
        policy.paymentLimit = next.paymentLimit;
        policy.buyLimit = next.buyLimit;
        policy.reserve = next.reserve;
        policy.perPayment = next.perPayment;
        policy.perBuy = next.perBuy;
        policy.perSell = next.perSell;
        policy.exceptionQuorum = next.exceptionQuorum;
        _replaceLists(next);
        ++policy.version;
    }

    function _requireUnchangedRoles(PolicyConfig calldata next) internal view {
        if (next.continuityReviewer != continuityReviewer || next.continuitySuccessor != continuitySuccessor || next.continuityPlanHash != continuityPlanHash || keccak256(abi.encode(next.exceptionSigners, next.guardians)) != _rolesCommitment) revert InvalidAction();
    }

    function _replaceLists(PolicyConfig calldata next) internal {
        if (next.sellCaps.length != next.sellCapTokens.length || next.exceptionQuorum == 0) revert InvalidAction();
        for (uint256 i; i < _approvedTokens.length; ++i) approvedToken[_approvedTokens[i]] = false;
        delete _approvedTokens;
        for (uint256 i; i < next.approvedTokens.length; ++i) { if (next.approvedTokens[i] == address(0) || next.approvedTokens[i] == policy.settlement) revert InvalidAction(); approvedToken[next.approvedTokens[i]] = true; _approvedTokens.push(next.approvedTokens[i]); }
        for (uint256 i; i < _paymentRecipients.length; ++i) approvedPaymentRecipient[_paymentRecipients[i]] = false;
        delete _paymentRecipients;
        for (uint256 i; i < next.paymentRecipients.length; ++i) { if (next.paymentRecipients[i] == address(0)) revert InvalidAction(); approvedPaymentRecipient[next.paymentRecipients[i]] = true; _paymentRecipients.push(next.paymentRecipients[i]); }
        for (uint256 i; i < _approvedAdapters.length; ++i) approvedAdapter[_approvedAdapters[i]] = false;
        delete _approvedAdapters;
        for (uint256 i; i < next.approvedAdapters.length; ++i) { if (next.approvedAdapters[i] == address(0)) revert InvalidAction(); approvedAdapter[next.approvedAdapters[i]] = true; _approvedAdapters.push(next.approvedAdapters[i]); }
        for (uint256 i; i < _sellCapTokens.length; ++i) sellLimit[_sellCapTokens[i]] = 0;
        delete _sellCapTokens;
        for (uint256 i; i < next.sellCapTokens.length; ++i) { if (!approvedToken[next.sellCapTokens[i]] || next.sellCaps[i] == 0) revert InvalidAction(); sellLimit[next.sellCapTokens[i]] = next.sellCaps[i]; _sellCapTokens.push(next.sellCapTokens[i]); }
    }

    function admitAdapter(address adapter, bool enabled) external onlyParent {
        if (adapter == address(0)) revert InvalidAction();
        if (!enabled) {
            if (pendingAdapter == adapter) { pendingAdapter = address(0); pendingAdapterReadyAt = 0; }
            approvedAdapter[adapter] = false;
            ++policy.version;
            emit PolicyVersionChanged(policy.version);
        } else {
            pendingAdapter = adapter;
            pendingAdapterReadyAt = uint64(block.timestamp + POLICY_REVIEW_DELAY);
            emit AdapterAdmissionQueued(adapter, pendingAdapterReadyAt);
        }
    }

    function executeAdapterAdmission() external onlyParent {
        if (pendingAdapter == address(0) || block.timestamp < pendingAdapterReadyAt) revert NotReady();
        if (!approvedAdapter[pendingAdapter]) _approvedAdapters.push(pendingAdapter);
        approvedAdapter[pendingAdapter] = true;
        pendingAdapter = address(0);
        pendingAdapterReadyAt = 0;
        ++policy.version;
        emit PolicyVersionChanged(policy.version);
    }

    function startRecovery(address newParent) external {
        if (!approvedGuardian[msg.sender] || newParent == address(0)) revert Unauthorized();
        if (recovery.active) {
            if (recovery.expiresAt == 0 || block.timestamp <= recovery.expiresAt) revert Pending();
            delete recovery;
        }
        ++recoveryNonce;
        recovery = Recovery(newParent, 0, uint64(block.timestamp + RECOVERY_LIFETIME), recoveryNonce, 0, true);
        _approveRecovery(recoveryNonce, msg.sender);
        emit RecoveryStarted(recoveryNonce, newParent, recovery.readyAt, recovery.expiresAt);
    }

    function approveRecovery(uint256 id) external {
        if (!approvedGuardian[msg.sender]) revert Unauthorized();
        if (!recovery.active || recovery.id != id || block.timestamp > recovery.expiresAt) revert InvalidAction();
        _approveRecovery(id, msg.sender);
        if (recovery.approvals >= 2 && recovery.readyAt == 0) {
            recovery.readyAt = uint64(block.timestamp + RECOVERY_DELAY);
            recovery.expiresAt = uint64(block.timestamp + RECOVERY_DELAY + RECOVERY_LIFETIME);
        }
    }

    function _approveRecovery(uint256 id, address guardian) internal {
        if (recoveryApproved[id][guardian]) revert BadApprovals();
        recoveryApproved[id][guardian] = true;
        ++recovery.approvals;
        emit RecoveryApproved(id, guardian, recovery.approvals);
    }

    function cancelRecovery() external onlyParent {
        if (!recovery.active) revert InvalidAction();
        uint256 id = recovery.id;
        delete recovery;
        emit RecoveryCancelled(id);
    }

    function executeRecovery() external {
        if (!recovery.active || recovery.approvals < 2 || recovery.readyAt == 0 || block.timestamp < recovery.readyAt || block.timestamp > recovery.expiresAt) revert NotReady();
        parent = recovery.newParent;
        ++securityEpoch;
        delegatedSpendingPaused = false;
        _clearPending();
        _invalidateIncapacity();
        delete succession;
        successionAccepted = false;
        uint256 id = recovery.id;
        address newParent = recovery.newParent;
        delete recovery;
        emit RecoveryExecuted(id, newParent, securityEpoch);
    }

    function requestSuccession(address successor, address reviewer, bytes32 planHash, bytes32 evidenceHash, uint64 deadline)
        external
    {
        if (msg.sender != parent && !approvedGuardian[msg.sender]) revert Unauthorized();
        if (succession.state >= 1 && succession.state <= 4 && block.timestamp <= succession.deadline) revert Pending();
        if (continuityReviewer == address(0) || reviewer != continuityReviewer || (continuitySuccessor != address(0) && successor != continuitySuccessor) || (continuityPlanHash != bytes32(0) && planHash != continuityPlanHash)) revert InvalidAction();
        if (successor == address(0) || reviewer == address(0) || planHash == bytes32(0) || evidenceHash == bytes32(0) || deadline <= block.timestamp) revert InvalidAction();
        ++recoveryNonce;
        successionAccepted = false;
        succession = Succession(planHash, evidenceHash, successor, reviewer, deadline, 0, recoveryNonce, 0, 1);
        emit SuccessionRequested(succession.id, successor, planHash, evidenceHash);
    }

    function successionApprovalHash(uint256 id) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, securityEpoch, "STEWARD_SUCCESSION_REVIEW_V1", id, succession.successor, succession.planHash, succession.evidenceHash, succession.deadline));
    }

    function approveSuccession(uint256 id, bytes calldata reviewerSignature) external {
        if (!approvedGuardian[msg.sender] || succession.id != id || succession.state != 1 || block.timestamp > succession.deadline) revert Unauthorized();
        if (succession.reviewer != continuityReviewer || _signer(successionApprovalHash(id), reviewerSignature) != succession.reviewer) revert BadApprovals();
        if (successionApproved[id][msg.sender]) revert BadApprovals();
        successionApproved[id][msg.sender] = true;
        ++succession.approvals;
        if (succession.approvals >= 2) {
            succession.state = 2;
            succession.challengeEnds = uint64(block.timestamp + SUCCESSION_CHALLENGE);
        }
        emit SuccessionApproved(id, msg.sender, succession.approvals);
    }

    function successionAcceptanceHash(uint256 id) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, securityEpoch, "STEWARD_SUCCESSION_ACCEPT_V1", id, succession.successor, succession.planHash));
    }

    function acceptSuccession(uint256 id, bytes calldata successorSignature) external {
        if (succession.id != id || msg.sender != succession.successor || !SignatureChecker.isValidSignatureNow(msg.sender, successionAcceptanceHash(id), successorSignature)) revert Unauthorized();
        successionAccepted = true;
    }

    function challengeSuccession(uint256 id) external {
        if (!approvedGuardian[msg.sender] || succession.id != id || succession.state != 2 || block.timestamp > succession.challengeEnds) revert Unauthorized();
        succession.state = 3;
        emit SuccessionChallenged(id, msg.sender);
    }

    function resolveSuccession(uint256 id, bool approved) external {
        if (msg.sender != succession.reviewer) revert Unauthorized();
        if (succession.id != id || succession.state != 3) revert InvalidAction();
        if (block.timestamp > succession.deadline) revert Expired();
        succession.state = approved ? 2 : 6;
        if (approved) succession.challengeEnds = uint64(block.timestamp + SUCCESSION_CHALLENGE);
    }

    function executeSuccession(uint256 id, bytes32 planHash, bytes32 evidenceHash) external {
        Succession memory s = succession;
        if (s.id != id || s.state != 2 || !successionAccepted || block.timestamp < s.challengeEnds || block.timestamp > s.deadline || s.planHash != planHash || s.evidenceHash != evidenceHash) revert NotReady();
        succession.state = 5;
        _clearPending();
        delete recovery;
        _invalidateIncapacity();
        parent = s.successor;
        ++securityEpoch;
        delegatedSpendingPaused = true;
        emit SuccessionExecuted(id, s.successor);
    }

    /// Parent/reviewer veto, or permissionless expiry, never transfers authority.
    function cancelSuccession() external {
        if (block.timestamp <= succession.deadline && msg.sender != parent && msg.sender != succession.reviewer) revert Unauthorized();
        succession.state = block.timestamp > succession.deadline ? 7 : 6;
    }

    function _clearPending() internal {
        delete pendingPolicy;
        delete pendingDelegate;
        pendingAdapter = address(0);
        pendingAdapterReadyAt = 0;
        pendingIncapacityModule = address(0);
        pendingIncapacityCaregiver = address(0);
        pendingIncapacityActionMask = 0;
        pendingIncapacityPerActionLimit = 0;
        pendingIncapacityReadyAt = 0;
    }

    function _invalidateIncapacity() internal {
        delegates[incapacityCaregiver].enabled = false;
        incapacityModule = address(0);
        incapacityCaregiver = address(0);
        incapacityActive = false;
    }

    modifier onlyParent() {
        if (msg.sender != parent) revert Unauthorized();
        _;
    }
}
