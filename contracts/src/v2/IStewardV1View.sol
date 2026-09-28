// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IStewardV1View {
    function parent() external view returns (address);
    function policy()
        external
        view
        returns (
            address settlement,
            uint64 period,
            uint64 anchor,
            uint256 paymentLimit,
            uint256 buyLimit,
            uint256 reserve,
            uint256 perPayment,
            uint256 perBuy,
            uint256 perSell,
            uint256 exceptionQuorum,
            uint256 version
        );
    function periodStart() external view returns (uint256);
    function securityEpoch() external view returns (uint256);
    function delegatedSpendingPaused() external view returns (bool);
    function delegates(address actor)
        external
        view
        returns (uint256 actionMask, uint256 perActionLimit, uint64 expiresAt, uint256 epoch, bool enabled);
    function approvedToken(address token) external view returns (bool);
    function policyAddresses(uint8 list) external view returns (address[] memory);
    function sellLimit(address token) external view returns (uint256);
    function buySpent(uint256 period) external view returns (uint256);
    function sellSpent(address token, uint256 period) external view returns (uint256);
    function usedNonce(address actor, uint256 epoch, uint256 nonce) external view returns (bool);
    function cancelledAction(bytes32 actionId) external view returns (bool);
    function cancelledForActor(address actor, bytes32 actionId) external view returns (bool);
    function executedAction(bytes32 actionId) external view returns (bool);
    function recovery()
        external
        view
        returns (address, uint64, uint64 expiresAt, uint256, uint256 approvals, bool active);
    function succession()
        external
        view
        returns (bytes32, bytes32, address, address, uint64 deadline, uint64, uint256, uint256, uint8 state);
}
