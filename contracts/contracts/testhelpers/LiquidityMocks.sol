// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
interface ILiquidityDEX {
    function addLiquidity(uint256,uint256,uint256,uint256,uint256,uint256,uint256) external returns(uint256);
}
contract FeeToken is ERC20 {
    bool public feeEnabled = true;
    function setFeeEnabled(bool enabled) external { feeEnabled = enabled; }
    constructor() ERC20("Fee Token", "FEE") { _mint(msg.sender, 1000 ether); }
    function _update(address from,address to,uint256 amount) internal override {
        if(feeEnabled&&from!=address(0)&&to!=address(0)) {
            uint256 fee=amount/100;
            super._update(from,address(0xdead),fee);
            super._update(from,to,amount-fee);
        } else super._update(from,to,amount);
    }
}
contract CallbackLP is IERC721Receiver {
    bool public reentryRejected;
    address private target;
    function provide(address dex,address a,address b,uint256 amount) external {
        target=dex;
        IERC20(a).approve(dex,amount);IERC20(b).approve(dex,amount);
        ILiquidityDEX(dex).addLiquidity(1,amount,amount,0,0,0,block.timestamp);
    }
    function onERC721Received(address,address,uint256,bytes calldata) external returns(bytes4) {
        (bool success,bytes memory reason)=target.call(abi.encodeCall(ILiquidityDEX.addLiquidity,(1,1,1,0,0,0,block.timestamp)));
        reentryRejected=!success && bytes4(reason)==bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        require(reentryRejected,"Expected reentrancy guard");
        return IERC721Receiver.onERC721Received.selector;
    }
}
