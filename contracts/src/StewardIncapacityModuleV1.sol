// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IStewardIncapacityAccount {
    function parent() external view returns (address);
    function securityEpoch() external view returns (uint256);
    function activateIncapacity(address caregiver, uint256 actionMask, uint256 perActionLimit, uint256 requestedEpoch, uint64 expiresAt) external;
    function deactivateIncapacity() external;
    function incapacityActive() external view returns (bool);
}

/// @notice A separate, enrolled incapacity transition controller. It never
/// owns or withdraws assets and cannot change the beneficial owner. Activation
/// only installs the one caregiver authority and exact limits chosen at
/// enrollment in the account; reviewer attestation and a distinct guardian
/// quorum are both required, followed by a bounded delay and expiry.
contract StewardIncapacityModuleV1 {
    uint64 public immutable activationDelay;
    uint64 public immutable requestLifetime;
    address public immutable account;
    address public immutable caregiver;
    address public immutable reviewer;
    uint256 public immutable actionMask;
    uint256 public immutable perActionLimit;
    bytes32 public immutable planHash;
    uint256 public immutable quorum;

    address[] private _guardians;
    mapping(address => bool) public enrolledGuardian;

    struct Case {
        bytes32 evidenceHash;
        uint256 epoch;
        uint64 deadline;
        uint64 readyAt;
        uint64 expiresAt;
        uint256 id;
        uint256 approvals;
        uint8 state; // 1 requested, 2 approved, 3 challenged, 5 executed, 6 cancelled, 7 expired
        bool reviewerApproved;
    }

    Case public current;
    uint256 public caseNonce;
    mapping(uint256 => mapping(address => bool)) public approved;

    event Requested(uint256 indexed id, bytes32 evidenceHash, uint256 epoch, uint64 deadline);
    event Approved(uint256 indexed id, address indexed guardian, uint256 approvals);
    event Challenged(uint256 indexed id, address indexed guardian);
    event Resolved(uint256 indexed id, bool approved, uint64 readyAt);
    event Executed(uint256 indexed id, address indexed caregiver, uint64 expiresAt);
    event Cancelled(uint256 indexed id);
    event Expired(uint256 indexed id);

    error Invalid();
    error Unauthorized();
    error Pending();
    error NotReady();
    error BadSignature();

    constructor(
        address account_,
        address caregiver_,
        address reviewer_,
        address[] memory guardians_,
        uint256 quorum_,
        uint256 actionMask_,
        uint256 perActionLimit_,
        bytes32 planHash_,
        uint64 activationDelay_,
        uint64 requestLifetime_
    ) {
        if (account_ == address(0) || caregiver_ == address(0) || reviewer_ == address(0) || planHash_ == bytes32(0)) revert Invalid();
        if (guardians_.length == 0 || quorum_ == 0 || quorum_ > guardians_.length || actionMask_ == 0 || requestLifetime_ == 0) revert Invalid();
        account = account_;
        caregiver = caregiver_;
        reviewer = reviewer_;
        quorum = quorum_;
        actionMask = actionMask_;
        perActionLimit = perActionLimit_;
        planHash = planHash_;
        activationDelay = activationDelay_ == 0 ? 48 hours : activationDelay_;
        requestLifetime = requestLifetime_;
        for (uint256 i; i < guardians_.length; ++i) {
            address guardian = guardians_[i];
            if (guardian == address(0) || guardian == reviewer_ || enrolledGuardian[guardian]) revert Invalid();
            enrolledGuardian[guardian] = true;
            _guardians.push(guardian);
        }
    }

    function guardians() external view returns (address[] memory) {
        return _guardians;
    }

    function reviewHash(uint256 id) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                current.epoch,
                "STEWARD_INCAPACITY_REVIEW_V1",
                id,
                caregiver,
                planHash,
                current.evidenceHash,
                current.deadline
            )
        );
    }

    function request(bytes32 evidenceHash, uint64 deadline) external returns (uint256 id) {
        if (!enrolledGuardian[msg.sender] || evidenceHash == bytes32(0) || deadline <= block.timestamp) revert Unauthorized();
        if ((current.state >= 1 && current.state <= 3) || (current.state == 5 && IStewardIncapacityAccount(account).incapacityActive())) revert Pending();
        uint256 epoch = IStewardIncapacityAccount(account).securityEpoch();
        ++caseNonce;
        current = Case(evidenceHash, epoch, deadline, 0, 0, caseNonce, 0, 1, false);
        emit Requested(caseNonce, evidenceHash, epoch, deadline);
        return caseNonce;
    }

    function approve(uint256 id, bytes calldata reviewerSignature) external {
        if (!enrolledGuardian[msg.sender] || current.id != id || current.state != 1 || block.timestamp > current.deadline) revert Unauthorized();
        if (!SignatureChecker.isValidSignatureNow(reviewer, reviewHash(id), reviewerSignature)) revert BadSignature();
        if (approved[id][msg.sender]) revert BadSignature();
        approved[id][msg.sender] = true;
        current.reviewerApproved = true;
        ++current.approvals;
        if (current.approvals >= quorum) {
            current.state = 2;
            current.readyAt = uint64(block.timestamp + activationDelay);
            current.expiresAt = uint64(current.readyAt + requestLifetime);
        }
        emit Approved(id, msg.sender, current.approvals);
    }

    function challenge(uint256 id) external {
        if (!enrolledGuardian[msg.sender] || current.id != id || current.state != 2 || block.timestamp >= current.readyAt) revert Unauthorized();
        current.state = 3;
        emit Challenged(id, msg.sender);
    }

    function resolve(uint256 id, bool approved_) external {
        if (msg.sender != reviewer || current.id != id || current.state != 3) revert Unauthorized();
        if (!approved_) {
            current.state = 6;
            emit Resolved(id, false, 0);
            return;
        }
        current.state = 2;
        current.readyAt = uint64(block.timestamp + activationDelay);
        current.expiresAt = uint64(current.readyAt + requestLifetime);
        emit Resolved(id, true, current.readyAt);
    }

    function cancel(uint256 id) external {
        address parent = IStewardIncapacityAccount(account).parent();
        if (msg.sender != parent && msg.sender != reviewer && !enrolledGuardian[msg.sender]) revert Unauthorized();
        if (current.id != id || current.state < 1 || current.state > 3) revert Invalid();
        current.state = 6;
        emit Cancelled(id);
    }

    function expire(uint256 id) external {
        if (current.id != id || !((current.state >= 1 && current.state <= 3) || current.state == 5)) revert NotReady();
        if (block.timestamp <= current.deadline && (current.state != 2 || block.timestamp <= current.expiresAt)) revert NotReady();
        bool activated = current.state == 5;
        current.state = 7;
        if (activated && current.epoch == IStewardIncapacityAccount(account).securityEpoch() && IStewardIncapacityAccount(account).incapacityActive()) {
            IStewardIncapacityAccount(account).deactivateIncapacity();
        }
        emit Expired(id);
    }

    function execute(uint256 id) external {
        Case memory c = current;
        if (c.id != id || c.state != 2 || block.timestamp < c.readyAt || block.timestamp > c.expiresAt || block.timestamp > c.deadline) revert NotReady();
        if (c.epoch != IStewardIncapacityAccount(account).securityEpoch()) revert Invalid();
        current.state = 5;
        IStewardIncapacityAccount(account).activateIncapacity(caregiver, actionMask, perActionLimit, c.epoch, c.deadline);
        emit Executed(id, caregiver, c.deadline);
    }
}
