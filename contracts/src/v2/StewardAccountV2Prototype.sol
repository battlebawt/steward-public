// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StewardAccountV1} from "../StewardAccountV1.sol";
import {StewardCowV2Storage} from "./StewardCowV2Storage.sol";
import {IStewardV1View} from "./IStewardV1View.sol";
import {StewardCowV2Module} from "./StewardCowV2Module.sol";

/// @notice Local-only, non-upgradeable V2 integration prototype. One proxy address owns
/// tokens and the V1 policy/continuity state; fixed CoW storage is namespaced there.
/// The V1 implementation and CoW module are immutable. No arbitrary calls or upgrades.
contract StewardAccountV2Prototype {
    address public immutable v1Implementation;
    address public immutable cowModule;

    error InvalidComponent();
    error ReservedFunds();

    constructor(
        address v1Implementation_,
        address cowModule_,
        address parent,
        StewardAccountV1.PolicyConfig memory config
    ) {
        if (v1Implementation_.code.length == 0 || cowModule_.code.length == 0) {
            revert InvalidComponent();
        }
        v1Implementation = v1Implementation_;
        cowModule = cowModule_;
        (bool ok, bytes memory result) =
            v1Implementation_.delegatecall(abi.encodeCall(StewardAccountV1.initialize, (parent, config)));
        if (!ok) _bubble(result);
    }

    receive() external payable {}

    fallback() external payable {
        bytes4 selector = msg.sig;
        if (
            selector == StewardCowV2Module.openOrder.selector || selector == StewardCowV2Module.cancelOrder.selector
                || selector == StewardCowV2Module.reconcile.selector
                || selector == StewardCowV2Module.isValidSignature.selector
                || selector == StewardCowV2Module.orderDigest.selector
                || selector == StewardCowV2Module.orderUid.selector
                || selector == StewardCowV2Module.pendingOrder.selector
                || selector == StewardCowV2Module.budgetStatus.selector
        ) {
            _delegate(cowModule);
        }
        if (selector == StewardAccountV1.withdraw.selector) {
            (address token, uint256 amount,) = abi.decode(msg.data[4:], (address, uint256, address));
            if (token != address(0)) _requireUnreserved(token, amount, 0);
        } else if (selector == StewardAccountV1.executePayment.selector) {
            (StewardAccountV1.Action memory a,) = abi.decode(msg.data[4:], (StewardAccountV1.Action, bytes[]));
            _requireUnusedCowIdentity(a);
            _requireUnreserved(a.tokenIn, a.amountInRaw, 0);
        } else if (selector == StewardAccountV1.executeTrade.selector) {
            (StewardAccountV1.Action memory a,) = abi.decode(msg.data[4:], (StewardAccountV1.Action, bytes[]));
            _requireUnusedCowIdentity(a);
            _preflightTrade(a);
        }
        _delegate(v1Implementation);
    }

    function _requireUnusedCowIdentity(StewardAccountV1.Action memory a) private view {
        StewardCowV2Storage.Layout storage l = StewardCowV2Storage.layout();
        if (l.usedNonce[a.actor][a.securityEpoch][a.nonce] || l.orders[a.actionId].state != 0) revert ReservedFunds();
    }

    function _preflightTrade(StewardAccountV1.Action memory a) private view {
        IStewardV1View v = IStewardV1View(address(this));
        StewardCowV2Storage.Layout storage l = StewardCowV2Storage.layout();
        (address settlement,,,, uint256 buyLimit, uint256 reserve,,,,,) = v.policy();
        uint256 period = v.periodStart();
        if (a.adapter == StewardCowV2Module(cowModule).relayer()) revert ReservedFunds();
        if (a.kind == 1) {
            if (
                a.exceptionMask == 0
                    && v.buySpent(period) + l.buySpent[period] + l.buyReserved[period] + a.amountInRaw > buyLimit
            ) {
                revert ReservedFunds();
            }
            _requireUnreserved(settlement, a.amountInRaw, reserve);
        } else if (a.kind == 2) {
            if (
                a.exceptionMask == 0
                    && v.sellSpent(a.tokenIn, period) + l.sellSpent[a.tokenIn][period]
                            + l.sellReserved[a.tokenIn][period] + a.amountInRaw > v.sellLimit(a.tokenIn)
            ) revert ReservedFunds();
            _requireUnreserved(a.tokenIn, a.amountInRaw, 0);
        }
    }

    function _requireUnreserved(address token, uint256 spend, uint256 reserve) private view {
        if (token == address(0)) return;
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 held = StewardCowV2Storage.layout().reservedByToken[token];
        if (spend > balance || held > balance - spend || reserve > balance - spend - held) revert ReservedFunds();
    }

    function _delegate(address implementation) private {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _bubble(bytes memory result) private pure {
        assembly {
            revert(add(result, 32), mload(result))
        }
    }
}
