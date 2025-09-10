// IMoveAdapter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMoveAdapter {
    // move `token` from `from` to `to` for `amount`
    function move(address token, address from, address to, uint256 amount) external;
}
