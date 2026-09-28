// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StewardAccountV1} from "../StewardAccountV1.sol";
import {StewardAccountV2Prototype} from "./StewardAccountV2Prototype.sol";

/// @notice Local-only fixed V2 enrollment. The factory creates its own V1
/// implementation and fixes one predeployed CoW module at construction;
/// account creators cannot substitute either component.
contract StewardFactoryV2Prototype {
    bytes32 public constant MANIFEST = keccak256("STEWARD_ACCOUNT_V2_LOCAL_COW_FIXED_COMPONENTS_2026-09-25");
    address public immutable v1Implementation;
    address public immutable cowModule;
    bytes32 public accountRuntimeCodeHash;
    mapping(address => bool) public isStewardAccount;
    address[] private _accounts;

    event AccountCreated(address indexed account, address indexed parent, bytes32 manifest);

    constructor(address cowModule_) {
        require(cowModule_.code.length != 0, "MODULE_MISSING");
        v1Implementation = address(new StewardAccountV1());
        cowModule = cowModule_;
    }

    function createAccount(address parent, StewardAccountV1.PolicyConfig calldata config)
        external
        returns (address account)
    {
        account = address(new StewardAccountV2Prototype(v1Implementation, cowModule, parent, config));
        bytes32 codeHash = account.codehash;
        if (accountRuntimeCodeHash == bytes32(0)) accountRuntimeCodeHash = codeHash;
        else require(codeHash == accountRuntimeCodeHash, "ACCOUNT_CODE_CHANGED");
        isStewardAccount[account] = true;
        _accounts.push(account);
        emit AccountCreated(account, parent, MANIFEST);
    }

    function accounts() external view returns (address[] memory) { return _accounts; }
    function accountCount() external view returns (uint256) { return _accounts.length; }
}
