// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IOracleHub.sol";

contract OracleHub is IOracleHub {
    address public owner;
    uint64 public override maxStaleness;

    mapping(address => PricePayload) private _price;
    mapping(address => BandPayload) private _band;

    event OwnerSet(address indexed owner);
    event MaxStalenessSet(uint64 seconds_);
    event PriceSet(
        address indexed asset,
        uint256 priceE6,
        uint64 seq,
        uint64 ts,
        bytes32 hcsMsgId
    );
    event BandSet(
        address indexed asset,
        uint256 midE6,
        uint32 widthBps,
        uint64 ts
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(uint64 maxStaleness_) {
        owner = msg.sender;
        maxStaleness = maxStaleness_;
        emit OwnerSet(owner);
        emit MaxStalenessSet(maxStaleness_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    function setMaxStaleness(uint64 s) external onlyOwner {
        maxStaleness = s;
        emit MaxStalenessSet(s);
    }

    function setPrice(
        address asset,
        PricePayload calldata p
    ) external onlyOwner {
        _price[asset] = p;
        emit PriceSet(asset, p.priceE6, p.seq, p.ts, p.hcsMsgId);
    }

    function setPrices(
        address[] memory assets,
        PricePayload[] calldata ps
    ) external onlyOwner {
        require(assets.length == ps.length, "Length mismatch");

        for (uint256 i = 0; i < assets.length; i++) {
            _price[assets[i]] = ps[i];
            emit PriceSet(
                assets[i],
                ps[i].priceE6,
                ps[i].seq,
                ps[i].ts,
                ps[i].hcsMsgId
            );
        }
    }

    function setBand(address asset, BandPayload calldata b) external onlyOwner {
        _band[asset] = b;
        emit BandSet(asset, b.midE6, b.widthBps, b.ts);
    }

    function setBands(
        address[] memory assets,
        BandPayload[] calldata bs
    ) external onlyOwner {
        require(assets.length == bs.length, "Length mismatch");

        for (uint256 i = 0; i < assets.length; i++) {
            _band[assets[i]] = bs[i];
            emit BandSet(assets[i], bs[i].midE6, bs[i].widthBps, bs[i].ts);
        }
    }

    function getPrice(
        address asset
    ) external view returns (PricePayload memory) {
        return _price[asset];
    }

    function getBand(address asset) external view returns (BandPayload memory) {
        return _band[asset];
    }
}
