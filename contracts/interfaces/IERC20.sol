// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function decimals() external view returns (uint8);

    function balanceOf(address) external view returns (uint256);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);

    function approve(address spender, uint256) external returns (bool);

    function transfer(address to, uint256) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256
    ) external returns (bool);
}