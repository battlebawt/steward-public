// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {StewardWebAuthn} from "./passkeys/StewardWebAuthn.sol";

/// @title StewardPasskeySignerV1
/// @notice Immutable ERC-1271 signer for one enrolled P-256 WebAuthn credential.
/// @dev The account owns the enrollment and epoch policy. It can admit this
/// contract as a signer using its existing abi.encode(address,bytes) envelope;
/// this contract never stores a private key or signs on behalf of the account.
contract StewardPasskeySignerV1 {
    bytes4 public constant MAGICVALUE = 0x1626ba7e;
    bytes4 public constant INVALID = 0xffffffff;
    bytes32 public constant VERSION = keccak256("STEWARD_PASSKEY_SIGNER_V1");

    bytes32 public immutable rpIdHash;
    bytes32 public immutable publicKeyX;
    bytes32 public immutable publicKeyY;
    uint256 public immutable enrolledEpoch;
    string public origin;

    error InvalidConfiguration();

    constructor(bytes32 rpIdHash_, string memory origin_, bytes32 x_, bytes32 y_, uint256 enrolledEpoch_) {
        if (
            rpIdHash_ == bytes32(0) || bytes(origin_).length == 0 || bytes(origin_).length > 255
                || !P256.isValidPublicKey(x_, y_) || enrolledEpoch_ == 0
        ) revert InvalidConfiguration();
        rpIdHash = rpIdHash_;
        origin = origin_;
        publicKeyX = x_;
        publicKeyY = y_;
        enrolledEpoch = enrolledEpoch_;
    }

    uint256 public callNonce;
    error InvalidCall();
    event CallExecuted(uint256 indexed nonce, address indexed target, bytes32 dataHash);

    function callHash(address target, uint256 value, bytes calldata data, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("STEWARD_PASSKEY_CALL_V1"), address(this), block.chainid, target, value, keccak256(data), nonce, deadline));
    }

    /// @notice Sponsored exact call for parent-only account operations. The
    /// sponsor pays gas/value; it receives no authority to change the signed call.
    function execute(address target, uint256 value, bytes calldata data, uint256 nonce, uint64 deadline, bytes calldata signature) external payable returns (bytes memory result) {
        if (target == address(0) || nonce != callNonce || block.timestamp > deadline || msg.value != value) revert InvalidCall();
        if (this.isValidSignature(callHash(target, value, data, nonce, deadline), signature) != MAGICVALUE) revert InvalidCall();
        ++callNonce;
        bool success;
        (success, result) = target.call{value:value}(data);
        if (!success) revert InvalidCall();
        emit CallExecuted(nonce, target, keccak256(data));
    }

    function challengeFor(bytes32 digest) public pure returns (bytes32) {
        // WebAuthn's clientData challenge is the exact digest supplied to
        // ERC-1271. The account already domain-separates action hashes, and
        // auth challenges use the same hashMessage digest as the API.
        return digest;
    }

    /// @notice ERC-1271 validation for abi.encode(bytes authenticatorData,
    /// string clientDataJSON, bytes32 r, bytes32 s).
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        try this._validate(digest, signature) returns (bool valid) {
            return valid ? MAGICVALUE : INVALID;
        } catch {
            return INVALID;
        }
    }

    function _validate(bytes32 digest, bytes calldata signature) external view returns (bool) {
        if (msg.sender != address(this)) return false;
        (bytes memory authenticatorData, string memory clientDataJSON, bytes32 r, bytes32 s) =
            abi.decode(signature, (bytes, string, bytes32, bytes32));
        // Require canonical ABI so a valid assertion cannot be smuggled with
        // ignored trailing bytes or non-canonical offsets.
        if (keccak256(abi.encode(authenticatorData, clientDataJSON, r, s)) != keccak256(signature)) return false;
        StewardWebAuthn.Assertion memory assertion = StewardWebAuthn.Assertion(authenticatorData, clientDataJSON, r, s);
        return StewardWebAuthn.verify(challengeFor(digest), assertion, publicKeyX, publicKeyY, rpIdHash, origin);
    }
}
