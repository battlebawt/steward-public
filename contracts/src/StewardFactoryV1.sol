// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StewardAccountV1} from "./StewardAccountV1.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Atomic initialization of minimal clones pointing permanently to one
/// immutable implementation. No upgrade admin or mutable implementation registry.
contract StewardFactoryV1 {
    bytes32 public constant MANIFEST = keccak256("STEWARD_ACCOUNT_V1_MANIFEST_2026-09-23_IMMEDIATE_DELEGATES");
    bytes32 public immutable accountCreationCodeHash;
    address public immutable implementation;
    address[] private _accounts;
    mapping(address => bool) public isStewardAccount;

    event AccountCreated(address indexed account, address indexed parent, bytes32 manifest);

    constructor() {
        implementation = address(new StewardAccountV1());
        accountCreationCodeHash = keccak256(type(StewardAccountV1).creationCode);
    }

    function createAccount(address parent, StewardAccountV1.PolicyConfig calldata config)
        external
        returns (address account)
    {
        account = Clones.clone(implementation);
        StewardAccountV1(payable(account)).initialize(parent, config);
        isStewardAccount[account] = true;
        _accounts.push(account);
        emit AccountCreated(account, parent, MANIFEST);
    }

    function accounts() external view returns (address[] memory) {
        return _accounts;
    }

    function accountCount() external view returns (uint256) {
        return _accounts.length;
    }
}
