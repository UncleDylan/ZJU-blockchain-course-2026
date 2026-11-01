// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
contract MiniDEX is ERC721Enumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 createdTimestamp;
        address creator;
    }

    struct Position {
        uint256 poolId;
        uint256 shares;
        uint256 amountA;
        uint256 amountB;
        uint256 createdTimestamp;
        address provider;
    }
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;
    mapping(uint256 => uint256) public redeemedAt;
    mapping(uint256 => address) public redeemedBy;
    error InsufficientLiquidity();
    error NotPositionOwner();
    event Swapped(uint256 indexed poolId, address indexed trader, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 feeAmount);
    event LiquidityRemoved(uint256 indexed poolId, uint256 indexed tokenId, address indexed owner, uint256 amountA, uint256 amountB, uint256 shares);
    uint256 public positionCount;
    mapping(uint256 => uint256) public totalShares;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => uint256[]) private poolPositions;

    error InvalidAmount();
    error DeadlineExpired();
    error SlippageExceeded();
    error UnsupportedTransfer();
    event LiquidityAdded(uint256 indexed poolId, uint256 indexed tokenId, address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);

    constructor() ERC721("MiniDEX Liquidity Position", "MDLP") {}

    uint256 public poolCount;
    mapping(uint256 => Pool) public pools;
    mapping(address => mapping(address => uint256)) public getPoolId;

    error InvalidTokenPair();
    error UnsupportedToken(address token);
    error PoolAlreadyExists(uint256 poolId);
    error PoolNotFound(uint256 poolId);
    error InvalidPageSize();
    event PoolCreated(uint256 indexed poolId, address indexed tokenA, address indexed tokenB, address creator);

    function createPool(address tokenA, address tokenB) external returns (uint256 poolId) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) revert InvalidTokenPair();
        (address first, address second) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        uint256 existing = getPoolId[first][second];
        if (existing != 0) revert PoolAlreadyExists(existing);
        _checkToken(first);
        _checkToken(second);
        poolId = ++poolCount;
        pools[poolId] = Pool(first, second, 0, 0, block.timestamp, msg.sender);
        getPoolId[first][second] = poolId;
        getPoolId[second][first] = poolId;
        emit PoolCreated(poolId, first, second, msg.sender);
    }

    function getPool(uint256 poolId) external view returns (Pool memory) {
        if (poolId == 0 || poolId > poolCount) revert PoolNotFound(poolId);
        return pools[poolId];
    }

    /// @param offset Number of pools to skip; pool IDs start at one.
    function getPools(uint256 offset, uint256 limit) external view returns (Pool[] memory result) {
        if (limit == 0 || limit > 100) revert InvalidPageSize();
        if (offset >= poolCount) return new Pool[](0);
        uint256 size = poolCount - offset;
        if (size > limit) size = limit;
        result = new Pool[](size);
        for (uint256 i; i < size; ++i) result[i] = pools[offset + i + 1];
    }

    function previewAddLiquidity(uint256 poolId, uint256 desiredA, uint256 desiredB)
        public view returns (uint256 amountA, uint256 amountB, uint256 shares)
    {
        if (poolId == 0 || poolId > poolCount) revert PoolNotFound(poolId);
        if (desiredA == 0 || desiredB == 0 || desiredA > type(uint128).max || desiredB > type(uint128).max) revert InvalidAmount();
        Pool storage pool = pools[poolId];
        uint256 supply = totalShares[poolId];
        if (supply == 0) {
            (amountA, amountB) = (desiredA, desiredB);
            uint256 root = Math.sqrt(amountA * amountB);
            if (root <= MINIMUM_LIQUIDITY) revert InvalidAmount();
            shares = root - MINIMUM_LIQUIDITY;
        } else {
            uint256 optimalB = Math.mulDiv(desiredA, pool.reserveB, pool.reserveA);
            if (optimalB <= desiredB) (amountA, amountB) = (desiredA, optimalB);
            else (amountA, amountB) = (Math.mulDiv(desiredB, pool.reserveA, pool.reserveB), desiredB);
            shares = Math.min(Math.mulDiv(amountA, supply, pool.reserveA), Math.mulDiv(amountB, supply, pool.reserveB));
        }
        if (amountA == 0 || amountB == 0 || shares == 0 || pool.reserveA + amountA > type(uint128).max || pool.reserveB + amountB > type(uint128).max) revert InvalidAmount();
    }

    function addLiquidity(uint256 poolId, uint256 desiredA, uint256 desiredB,
        uint256 minA, uint256 minB, uint256 minShares, uint256 deadline)
        external nonReentrant returns (uint256 tokenId)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        (uint256 amountA, uint256 amountB, uint256 shares) = previewAddLiquidity(poolId, desiredA, desiredB);
        if (amountA < minA || amountB < minB || shares < minShares) revert SlippageExceeded();
        Pool storage pool = pools[poolId];
        _receiveToken(pool.tokenA, amountA);
        _receiveToken(pool.tokenB, amountB);
        if (totalShares[poolId] == 0) totalShares[poolId] = MINIMUM_LIQUIDITY;
        totalShares[poolId] += shares;
        pool.reserveA += amountA;
        pool.reserveB += amountB;
        tokenId = ++positionCount;
        positions[tokenId] = Position(poolId, shares, amountA, amountB, block.timestamp, msg.sender);
        poolPositions[poolId].push(tokenId);
        _safeMint(msg.sender, tokenId);
        emit LiquidityAdded(poolId, tokenId, msg.sender, amountA, amountB, shares);
    }

    /// @notice Exact-input quote. Fees stay in reserves and accrue to pool shares.
    function quoteSwap(uint256 poolId, address tokenIn, uint256 amountIn)
        public view returns (uint256 amountOut, uint256 feeAmount)
    {
        if (poolId == 0 || poolId > poolCount) revert PoolNotFound(poolId);
        Pool storage pool = pools[poolId];
        if (tokenIn != pool.tokenA && tokenIn != pool.tokenB) revert InvalidTokenPair();
        if (amountIn == 0 || amountIn > type(uint128).max) revert InvalidAmount();
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == pool.tokenA
            ? (pool.reserveA, pool.reserveB) : (pool.reserveB, pool.reserveA);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        if (reserveIn + amountIn > type(uint128).max) revert InvalidAmount();
        uint256 effectiveInput = amountIn * (BPS - FEE_BPS);
        amountOut = Math.mulDiv(effectiveInput, reserveOut, reserveIn * BPS + effectiveInput);
        feeAmount = Math.mulDiv(amountIn, FEE_BPS, BPS);
        if (amountOut == 0 || amountOut >= reserveOut) revert InsufficientLiquidity();
    }

    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        external nonReentrant returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        uint256 feeAmount;
        (amountOut, feeAmount) = quoteSwap(poolId, tokenIn, amountIn);
        if (amountOut < minAmountOut) revert SlippageExceeded();
        Pool storage pool = pools[poolId];
        bool aToB = tokenIn == pool.tokenA;
        _receiveToken(tokenIn, amountIn);
        if (aToB) { pool.reserveA += amountIn; pool.reserveB -= amountOut; }
        else { pool.reserveB += amountIn; pool.reserveA -= amountOut; }
        _sendToken(aToB ? pool.tokenB : pool.tokenA, msg.sender, amountOut);
        emit Swapped(poolId, msg.sender, tokenIn, amountIn, amountOut, feeAmount);
    }

    function previewRemoveLiquidity(uint256 tokenId) public view returns (uint256 amountA, uint256 amountB) {
        _requireOwned(tokenId);
        Position memory position = positions[tokenId];
        Pool storage pool = pools[position.poolId];
        uint256 supply = totalShares[position.poolId];
        amountA = Math.mulDiv(pool.reserveA, position.shares, supply);
        amountB = Math.mulDiv(pool.reserveB, position.shares, supply);
        if (amountA == 0 || amountB == 0) revert InvalidAmount();
    }

    /// @notice Burn one complete position and return its current share of both assets.
    function removeLiquidity(uint256 tokenId, uint256 minA, uint256 minB, uint256 deadline)
        external nonReentrant returns (uint256 amountA, uint256 amountB)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (_requireOwned(tokenId) != msg.sender) revert NotPositionOwner();
        (amountA, amountB) = previewRemoveLiquidity(tokenId);
        if (amountA < minA || amountB < minB) revert SlippageExceeded();
        Position memory position = positions[tokenId];
        Pool storage pool = pools[position.poolId];
        pool.reserveA -= amountA;
        pool.reserveB -= amountB;
        totalShares[position.poolId] -= position.shares;
        redeemedAt[tokenId] = block.timestamp;
        redeemedBy[tokenId] = msg.sender;
        _burn(tokenId);
        _sendToken(pool.tokenA, msg.sender, amountA);
        _sendToken(pool.tokenB, msg.sender, amountB);
        emit LiquidityRemoved(position.poolId, tokenId, msg.sender, amountA, amountB, position.shares);
    }

    function _sendToken(address token, address recipient, uint256 amount) private {
        uint256 beforeSender = IERC20(token).balanceOf(address(this));
        uint256 beforeRecipient = IERC20(token).balanceOf(recipient);
        IERC20(token).safeTransfer(recipient, amount);
        if (IERC20(token).balanceOf(address(this)) != beforeSender - amount ||
            IERC20(token).balanceOf(recipient) != beforeRecipient + amount) revert UnsupportedTransfer();
    }

    function _receiveToken(address token, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedTransfer();
    }

    function getPoolPositionIds(uint256 poolId, uint256 offset, uint256 limit) external view returns (uint256[] memory result) {
        if (poolId == 0 || poolId > poolCount) revert PoolNotFound(poolId);
        if (limit == 0 || limit > 100) revert InvalidPageSize();
        uint256 length = poolPositions[poolId].length;
        if (offset >= length) return new uint256[](0);
        uint256 size = Math.min(length - offset, limit);
        result = new uint256[](size);
        for (uint256 i; i < size; ++i) result[i] = poolPositions[poolId][offset + i];
    }

    function getOwnerPositionIds(address owner, uint256 offset, uint256 limit) external view returns (uint256[] memory result) {
        if (limit == 0 || limit > 100) revert InvalidPageSize();
        uint256 length = balanceOf(owner);
        if (offset >= length) return new uint256[](0);
        uint256 size = Math.min(length - offset, limit);
        result = new uint256[](size);
        for (uint256 i; i < size; ++i) result[i] = tokenOfOwnerByIndex(owner, offset + i);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Position memory position = positions[tokenId];
        Pool memory pool = pools[position.poolId];
        bytes memory json = abi.encodePacked('{"name":"MiniDEX Position #', tokenId.toString(),
            '","description":"ERC721 liquidity position. Deposited amounts are historical; shares represent pool ownership.",',
            '"poolId":"', position.poolId.toString(), '","shares":"', position.shares.toString(),
            '","amountA":"', position.amountA.toString(), '","amountB":"', position.amountB.toString(),
            '","createdTimestamp":"', position.createdTimestamp.toString(),
            '","tokenA":"', Strings.toHexString(pool.tokenA), '","tokenB":"', Strings.toHexString(pool.tokenB), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function _checkToken(address token) private view {
        if (token.code.length == 0) revert UnsupportedToken(token);
        try IERC20(token).totalSupply() returns (uint256) {} catch { revert UnsupportedToken(token); }
        try IERC20(token).balanceOf(address(this)) returns (uint256) {} catch { revert UnsupportedToken(token); }
        try IERC20(token).allowance(address(this), address(this)) returns (uint256) {} catch { revert UnsupportedToken(token); }
    }
}
