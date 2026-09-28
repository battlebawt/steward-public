// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice Narrow WebAuthn assertion verifier for a fixed, enrolled passkey.
/// @dev The parser consumes the JSON object instead of searching for substrings.
/// It intentionally accepts the small client-data shape produced by browser
/// assertions, allows Chromium's single standard GREASE property, and fails
/// closed for other unknown properties or JSON escapes.
library StewardWebAuthn {
    error InvalidClientData();

    struct Assertion {
        bytes authenticatorData;
        string clientDataJSON;
        bytes32 r;
        bytes32 s;
    }

    function verify(
        bytes32 challenge,
        Assertion memory assertion,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        string memory origin
    ) internal view returns (bool) {
        if (assertion.authenticatorData.length != 37 || bytes(assertion.clientDataJSON).length > 2048) return false;
        bytes memory auth = assertion.authenticatorData;
        bytes32 observedRpIdHash;
        assembly { observedRpIdHash := mload(add(auth, 32)) }
        if (observedRpIdHash != rpIdHash) return false;
        uint8 flags = uint8(assertion.authenticatorData[32]);
        // UP and UV are required. Attested credential data and extensions are
        // rejected because this signer only accepts an assertion, not creation data.
        if (flags & 5 != 5 || flags & 0xC0 != 0) return false;
        if (!_clientDataMatches(bytes(assertion.clientDataJSON), challenge, origin)) return false;
        return P256.verify(
            sha256(abi.encodePacked(assertion.authenticatorData, sha256(bytes(assertion.clientDataJSON)))),
            assertion.r,
            assertion.s,
            x,
            y
        );
    }

    function _clientDataMatches(bytes memory json, bytes32 challenge, string memory origin)
        private
        pure
        returns (bool)
    {
        uint256 cursor;
        bool typeSeen;
        bool challengeSeen;
        bool originSeen;
        bool crossOriginSeen;
        bool otherKeysCanBeAddedSeen;
        bool commaPending;
        uint256 nextCursor;
        string memory key;
        string memory value;
        cursor = _expectByte(json, cursor, 0x7B); // {
        while (true) {
            cursor = _skipSpace(json, cursor);
            if (cursor >= json.length) return false;
            if (json[cursor] == 0x7D) {
                // }
                if (commaPending) return false;
                cursor++;
                break;
            }
            commaPending = false;
            (key, nextCursor) = _readString(json, cursor);
            cursor = nextCursor;
            cursor = _skipSpace(json, cursor);
            cursor = _expectByte(json, cursor, 0x3A); // :
            cursor = _skipSpace(json, cursor);
            if (keccak256(bytes(key)) == keccak256("type")) {
                if (typeSeen) return false;
                (value, nextCursor) = _readString(json, cursor);
                cursor = nextCursor;
                if (keccak256(bytes(value)) != keccak256("webauthn.get")) return false;
                typeSeen = true;
            } else if (keccak256(bytes(key)) == keccak256("challenge")) {
                if (challengeSeen) return false;
                (value, nextCursor) = _readString(json, cursor);
                cursor = nextCursor;
                if (keccak256(bytes(value)) != keccak256(bytes(Base64.encodeURL(abi.encodePacked(challenge))))) {
                    return false;
                }
                challengeSeen = true;
            } else if (keccak256(bytes(key)) == keccak256("origin")) {
                if (originSeen) return false;
                (value, nextCursor) = _readString(json, cursor);
                cursor = nextCursor;
                if (keccak256(bytes(value)) != keccak256(bytes(origin))) return false;
                originSeen = true;
            } else if (keccak256(bytes(key)) == keccak256("crossOrigin")) {
                if (crossOriginSeen || cursor + 5 > json.length) return false;
                if (
                    json[cursor] != 0x66 || json[cursor + 1] != 0x61 || json[cursor + 2] != 0x6C
                        || json[cursor + 3] != 0x73 || json[cursor + 4] != 0x65
                ) return false;
                cursor += 5;
                crossOriginSeen = true;
            } else if (keccak256(bytes(key)) == keccak256("other_keys_can_be_added_here")) {
                if (otherKeysCanBeAddedSeen) return false;
                (value, nextCursor) = _readString(json, cursor);
                cursor = nextCursor;
                otherKeysCanBeAddedSeen = true;
            } else {
                // Reject unrecognised keys instead of accepting a matching
                // substring in an attacker-controlled JSON value.
                return false;
            }
            cursor = _skipSpace(json, cursor);
            if (cursor >= json.length) return false;
            if (json[cursor] == 0x2C) {
                cursor++; // ,
                commaPending = true;
                continue;
            }
            if (json[cursor] == 0x7D) {
                cursor++; // }
                break;
            }
            return false;
        }
        return cursor == json.length && typeSeen && challengeSeen && originSeen && crossOriginSeen;
    }

    function _readString(bytes memory input, uint256 cursor) private pure returns (string memory value, uint256 next) {
        if (cursor >= input.length || input[cursor] != 0x22) revert InvalidClientData(); // "
        cursor++;
        bytes memory output = new bytes(input.length - cursor);
        uint256 length;
        while (cursor < input.length) {
            bytes1 current = input[cursor++];
            if (current == 0x22) {
                assembly { mstore(output, length) }
                return (string(output), cursor);
            }
            if (current == 0x5C || uint8(current) < 0x20) revert InvalidClientData(); // reject escapes/control chars
            output[length++] = current;
        }
        revert InvalidClientData();
    }

    function _skipSpace(bytes memory input, uint256 cursor) private pure returns (uint256) {
        while (
            cursor < input.length
                && (input[cursor] == 0x20 || input[cursor] == 0x09 || input[cursor] == 0x0A || input[cursor] == 0x0D)
        ) cursor++;
        return cursor;
    }

    function _expectByte(bytes memory input, uint256 cursor, uint8 expected) private pure returns (uint256) {
        cursor = _skipSpace(input, cursor);
        if (cursor >= input.length || uint8(input[cursor]) != expected) revert InvalidClientData();
        return cursor + 1;
    }
}
