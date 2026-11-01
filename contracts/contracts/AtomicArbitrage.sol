// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MiniDEX} from "./MiniDEX.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Capital-funded two-venue arbitrage. Both swaps succeed or everything reverts.
contract AtomicArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;
    MiniDEX public immutable dex1;
    MiniDEX public immutable dex2;
    struct Params {
        bool startOnFirst;
        uint256 firstPoolId;
        uint256 secondPoolId;
        address tokenIn;
        uint256 amountIn;
        uint256 minIntermediate;
        uint256 minProfit;
        uint256 deadline;
    }
    error InvalidVenue();
    error InvalidRoute();
    error InvalidAmount();
    error DeadlineExpired();
    error InsufficientProfit(uint256 returnedAmount, uint256 requiredAmount);
    error UnsupportedTransfer();
    event ArbitrageExecuted(address indexed trader, address indexed tokenIn, bool startOnFirst,
        uint256 firstPoolId, uint256 secondPoolId, uint256 amountIn, uint256 intermediateAmount,
        uint256 returnedAmount, uint256 profit);

    constructor(address first, address second) {
        if (first == second || first.code.length == 0 || second.code.length == 0) revert InvalidVenue();
        dex1 = MiniDEX(first); dex2 = MiniDEX(second);
    }

    function _route(bool startOnFirst, uint256 firstPoolId, uint256 secondPoolId, address tokenIn)
        private view returns (MiniDEX first, MiniDEX second, address middle)
    {
        (first, second) = startOnFirst ? (dex1, dex2) : (dex2, dex1);
        MiniDEX.Pool memory a = first.getPool(firstPoolId);
        MiniDEX.Pool memory b = second.getPool(secondPoolId);
        if (a.tokenA != b.tokenA || a.tokenB != b.tokenB || (tokenIn != a.tokenA && tokenIn != a.tokenB)) revert InvalidRoute();
        middle = tokenIn == a.tokenA ? a.tokenB : a.tokenA;
    }

    function quote(bool startOnFirst, uint256 firstPoolId, uint256 secondPoolId, address tokenIn, uint256 amountIn)
        external view returns (uint256 intermediateAmount, uint256 returnedAmount, uint256 profit)
    {
        (MiniDEX first, MiniDEX second, address middle) = _route(startOnFirst, firstPoolId, secondPoolId, tokenIn);
        (intermediateAmount,) = first.quoteSwap(firstPoolId, tokenIn, amountIn);
        (returnedAmount,) = second.quoteSwap(secondPoolId, middle, intermediateAmount);
        profit = returnedAmount > amountIn ? returnedAmount - amountIn : 0;
    }

    function execute(Params calldata p) external nonReentrant returns (uint256 profit) {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        if (p.amountIn == 0 || p.amountIn > type(uint128).max || p.minProfit == 0 || p.minProfit > type(uint128).max || p.minIntermediate == 0) revert InvalidAmount();
        (MiniDEX first, MiniDEX second, address middle) = _route(p.startOnFirst, p.firstPoolId, p.secondPoolId, p.tokenIn);
        IERC20 input = IERC20(p.tokenIn);
        IERC20 intermediate = IERC20(middle);
        uint256 beforeInput = input.balanceOf(address(this));
        uint256 beforeMiddle = intermediate.balanceOf(address(this));
        uint256 beforeTrader = input.balanceOf(msg.sender);
        input.safeTransferFrom(msg.sender, address(this), p.amountIn);
        if (input.balanceOf(address(this)) != beforeInput + p.amountIn) revert UnsupportedTransfer();
        input.forceApprove(address(first), p.amountIn);
        uint256 amountMiddle = first.swap(p.firstPoolId, p.tokenIn, p.amountIn, p.minIntermediate, p.deadline);
        input.forceApprove(address(first), 0);
        if (intermediate.balanceOf(address(this)) != beforeMiddle + amountMiddle) revert UnsupportedTransfer();
        intermediate.forceApprove(address(second), amountMiddle);
        uint256 returned = second.swap(p.secondPoolId, middle, amountMiddle, 1, p.deadline);
        intermediate.forceApprove(address(second), 0);
        if (input.balanceOf(address(this)) != beforeInput + returned || intermediate.balanceOf(address(this)) != beforeMiddle) revert UnsupportedTransfer();
        uint256 required = p.amountIn + p.minProfit;
        if (returned < required) revert InsufficientProfit(returned, required);
        profit = returned - p.amountIn;
        input.safeTransfer(msg.sender, returned);
        if (input.balanceOf(address(this)) != beforeInput || input.balanceOf(msg.sender) != beforeTrader + profit) revert UnsupportedTransfer();
        emit ArbitrageExecuted(msg.sender, p.tokenIn, p.startOnFirst, p.firstPoolId, p.secondPoolId,
            p.amountIn, amountMiddle, returned, profit);
    }
}
