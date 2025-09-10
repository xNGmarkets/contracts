// DirectSettleAdapter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IMoveAdapter.sol";

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

contract DirectSettleAdapter is IMoveAdapter {
    error ERC20TransferFromFailed();

    function move(
        address token,
        address from,
        address to,
        uint256 amount
    ) external override {
        if (amount == 0) return;
        if (!IERC20(token).transferFrom(from, to, amount))
            revert ERC20TransferFromFailed();
    }
}
