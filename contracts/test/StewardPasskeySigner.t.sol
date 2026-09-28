// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {StewardPasskeySignerV1} from "../src/StewardPasskeySignerV1.sol";

contract ParentOnlyTarget {
    address public immutable parent;
    uint256 public value;
    constructor(address parent_) { parent = parent_; }
    function setValue(uint256 next) external { require(msg.sender == parent); value = next; }
    function reject() external pure { revert(); }
}

contract StewardPasskeySignerTest is Test {
    uint256 internal constant P256_KEY = 111;
    bytes32 internal constant RP_ID_HASH = sha256("localhost");
    string internal constant ORIGIN = "http://localhost:5173";

    StewardPasskeySignerV1 internal signer;
    bytes32 internal digest = keccak256("steward action digest");

    function setUp() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(P256_KEY);
        signer = new StewardPasskeySignerV1(RP_ID_HASH, ORIGIN, bytes32(x), bytes32(y), 7);
    }

    function _signature(
        bytes32 digest_,
        bytes32 rpIdHash_,
        uint8 flags_,
        string memory origin_,
        string memory extraJson_
    ) internal returns (bytes memory) {
        return _signatureForChallenge(signer.challengeFor(digest_), rpIdHash_, flags_, origin_, extraJson_);
    }

    function _signatureForChallenge(
        bytes32 challenge,
        bytes32 rpIdHash_,
        uint8 flags_,
        string memory origin_,
        string memory extraJson_
    ) internal returns (bytes memory) {
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            origin_,
            '","crossOrigin":false',
            extraJson_,
            "}"
        );
        return _signatureForJson(json, rpIdHash_, flags_);
    }

    function _signatureForJson(string memory json, bytes32 rpIdHash_, uint8 flags_) internal pure returns (bytes memory) {
        bytes memory authenticatorData = abi.encodePacked(rpIdHash_, bytes1(flags_), bytes4(0));
        (bytes32 r, bytes32 s) = vm.signP256(P256_KEY, sha256(abi.encodePacked(authenticatorData, sha256(bytes(json)))));
        return abi.encode(authenticatorData, json, r, s);
    }

    function testValidAssertionBindsExactDigestAndReturnsERC1271Magic() public {
        bytes memory signature = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, "");
        assertEq(signer.isValidSignature(digest, signature), signer.MAGICVALUE());
        assertEq(signer.enrolledEpoch(), 7);
    }

    function testTamperedDigestCannotReuseAssertion() public {
        bytes memory signature = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, "");
        assertEq(signer.isValidSignature(keccak256("different action"), signature), signer.INVALID());

        bytes memory tamperedChallenge =
            _signatureForChallenge(keccak256("different challenge"), RP_ID_HASH, 0x05, ORIGIN, "");
        assertEq(signer.isValidSignature(digest, tamperedChallenge), signer.INVALID());
    }

    function testTamperedOriginAndRpIdAreRejectedEvenWhenResigned() public {
        bytes memory wrongOrigin = _signature(digest, RP_ID_HASH, 0x05, "https://evil.example", "");
        assertEq(signer.isValidSignature(digest, wrongOrigin), signer.INVALID());

        bytes memory wrongRp = _signature(digest, keccak256("other.example"), 0x05, ORIGIN, "");
        assertEq(signer.isValidSignature(digest, wrongRp), signer.INVALID());
    }

    function testUserPresenceAndVerificationAreBothRequired() public {
        bytes memory noUserVerification = _signature(digest, RP_ID_HASH, 0x01, ORIGIN, "");
        assertEq(signer.isValidSignature(digest, noUserVerification), signer.INVALID());

        bytes memory noUserPresence = _signature(digest, RP_ID_HASH, 0x04, ORIGIN, "");
        assertEq(signer.isValidSignature(digest, noUserPresence), signer.INVALID());
    }

    function testUnknownClientDataPropertiesDoNotPassBySubstring() public {
        bytes memory unknownProperty = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, ',"unexpected":"origin"');
        assertEq(signer.isValidSignature(digest, unknownProperty), signer.INVALID());
    }

    function testChromiumGreaseClientDataPropertyIsAcceptedAndSignedVerbatim() public {
        bytes memory assertion = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, ',"other_keys_can_be_added_here":"string20%time"');
        assertEq(signer.isValidSignature(digest, assertion), signer.MAGICVALUE());
    }

    function testChromiumGreasePropertyMustBeUniqueAndString() public {
        bytes memory duplicate = _signature(
            digest,
            RP_ID_HASH,
            0x05,
            ORIGIN,
            ',"other_keys_can_be_added_here":"first","other_keys_can_be_added_here":"second"'
        );
        assertEq(signer.isValidSignature(digest, duplicate), signer.INVALID());

        bytes memory malformed = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, ',"other_keys_can_be_added_here":false');
        assertEq(signer.isValidSignature(digest, malformed), signer.INVALID());
    }

    function testGreaseKeyIsExactAndDoesNotRelaxRequiredFields() public {
        bytes memory substringKey = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, ',"prefix_other_keys_can_be_added_here":"value"');
        assertEq(signer.isValidSignature(digest, substringKey), signer.INVALID());

        string memory wrongType = string.concat(
            '{"type":"webauthn.create","challenge":"',
            Base64.encodeURL(abi.encodePacked(signer.challengeFor(digest))),
            '","origin":"',
            ORIGIN,
            '","crossOrigin":false,"other_keys_can_be_added_here":"value"}'
        );
        assertEq(signer.isValidSignature(digest, _signatureForJson(wrongType, RP_ID_HASH, 0x05)), signer.INVALID());

        string memory wrongChallenge = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(keccak256("wrong challenge"))),
            '","origin":"',
            ORIGIN,
            '","crossOrigin":false,"other_keys_can_be_added_here":"value"}'
        );
        assertEq(signer.isValidSignature(digest, _signatureForJson(wrongChallenge, RP_ID_HASH, 0x05)), signer.INVALID());
    }

    function testTrailingCommaIsInvalidJson() public {
        bytes memory trailingComma = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, ",");
        assertEq(signer.isValidSignature(digest, trailingComma), signer.INVALID());
    }

    function testTamperedP256SignatureAndMalformedAbiReturnInvalid() public {
        bytes memory signature = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, "");
        // The static tuple slots are the two 32-byte values after the dynamic
        // offsets; alter the first byte of s rather than ABI padding.
        signature[96] = bytes1(uint8(signature[96]) ^ 1);
        assertEq(signer.isValidSignature(digest, signature), signer.INVALID());
        assertEq(signer.isValidSignature(digest, hex"1234"), signer.INVALID());

        bytes memory trailing = _signature(digest, RP_ID_HASH, 0x05, ORIGIN, "");
        trailing = bytes.concat(trailing, hex"00");
        assertEq(signer.isValidSignature(digest, trailing), signer.INVALID());
    }
    function testSponsoredParentCallBindsFieldsAndRejectsReplay() public {
        ParentOnlyTarget target = new ParentOnlyTarget(address(signer));
        bytes memory data = abi.encodeCall(target.setValue,(42));
        uint64 deadline = uint64(block.timestamp+1 hours);
        bytes32 expected = keccak256(abi.encode(keccak256("STEWARD_PASSKEY_CALL_V1"),address(signer),block.chainid,address(target),uint256(0),keccak256(data),uint256(0),deadline));
        assertEq(signer.callHash(address(target),0,data,0,deadline),expected);
        bytes memory sig = _signature(expected,RP_ID_HASH,0x05,ORIGIN,"");
        vm.expectRevert(StewardPasskeySignerV1.InvalidCall.selector);
        signer.execute(address(target),0,abi.encodeCall(target.setValue,(43)),0,deadline,sig);
        signer.execute(address(target),0,data,0,deadline,sig);
        assertEq(target.value(),42);
        assertEq(signer.callNonce(),1);
        vm.expectRevert(StewardPasskeySignerV1.InvalidCall.selector);
        signer.execute(address(target),0,data,0,deadline,sig);
    }

    function testSponsoredCallExpiryAndRevertPreserveNonce() public {
        ParentOnlyTarget target = new ParentOnlyTarget(address(signer));
        bytes memory data = abi.encodeCall(target.reject,());
        uint64 deadline = uint64(block.timestamp+1 hours);
        bytes memory sig = _signature(signer.callHash(address(target),0,data,0,deadline),RP_ID_HASH,0x05,ORIGIN,"");
        vm.expectRevert(StewardPasskeySignerV1.InvalidCall.selector);
        signer.execute(address(target),0,data,0,deadline,sig);
        assertEq(signer.callNonce(),0);
        vm.warp(block.timestamp+2 hours);
        vm.expectRevert(StewardPasskeySignerV1.InvalidCall.selector);
        signer.execute(address(target),0,data,0,deadline,sig);
    }

}
