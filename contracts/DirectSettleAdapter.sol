// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

/// @notice Direct settlement adapter used by CLOB (stateless; no custody).
contract DirectSettleAdapter {
    error ERC20TransferFromFailed();

    /// @dev Anyone may call; CLOB typically orchestrates calls. Requires allowances/associations on token side.
    function move(
        address token,
        address from,
        address to,
        uint256 amount
    ) external {
        if (amount == 0) return;
        if (!IERC20(token).transferFrom(from, to, amount))
            revert ERC20TransferFromFailed();
    }
}
