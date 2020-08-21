pragma solidity ^0.6.12;

contract GasEstimation {
    
    uint public x;
    uint public y;

    uint public endGas;
    
    function setValue(uint _x) public {
        x = _x;
    }

    function setValueWithEstimate(uint _x) public {
        x = _x;

        uint _startGas = gasleft();
        require(_startGas >= 1000, "not enough gas");
        y = _x;

        refund(_startGas);
    }

    function refund(uint256 g) internal {
      endGas = g - gasleft();
    }
}