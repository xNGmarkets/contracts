// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITokenAdapter {
    function transferIn(address token, address from, uint256 amount) external;
    function transferOut(address token, address to, uint256 amount) external;
}
