// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleHub {
    struct PricePayload {
        uint256 priceE6;
        uint64 seq;
        uint64 ts;
        bytes32 hcsMsgId;
    }
    struct BandPayload {
        uint256 midE6;
        uint32 widthBps;
        uint64 ts;
    }

    function getPrice(
        address asset
    ) external view returns (PricePayload memory);

    function getBand(address asset) external view returns (BandPayload memory);

    function maxStaleness() external view returns (uint64);
}
