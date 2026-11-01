// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A development token: each address may claim 1,000 tokens per day.
contract TestToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 18;
    uint256 public constant CLAIM_COOLDOWN = 1 days;

    mapping(address => uint256) public nextClaimAt;

    error FaucetCooldown(uint256 availableAt);
    event TokensClaimed(address indexed account, uint256 amount, uint256 availableAt);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function claim() external {
        if (block.timestamp < nextClaimAt[msg.sender]) {
            revert FaucetCooldown(nextClaimAt[msg.sender]);
        }
        uint256 availableAt = block.timestamp + CLAIM_COOLDOWN;
        nextClaimAt[msg.sender] = availableAt;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit TokensClaimed(msg.sender, FAUCET_AMOUNT, availableAt);
    }
}
