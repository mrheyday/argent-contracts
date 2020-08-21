/* global */
const GasEstimation = require("../build/GasEstimation");

const TestManager = require("../utils/test-manager");

describe("Gas Estimation tests", () => {
  const manager = new TestManager();

  let deployer;
  let gasEstimation;

  before(async () => {
    deployer = manager.newDeployer();
  });

  beforeEach(async () => {
    gasEstimation = await deployer.deploy(GasEstimation);
  });

  describe("Gas estimation correctness", () => {
    it.only("when using gasleft()", async () => {
      let gasEstimate = await gasEstimation.estimate.setValue(1, { gasLimit: 2000000, gasPrice: 1 });
      let tx = await gasEstimation.setValue(1, { gasLimit: 2000000, gasPrice: 1 });
      let txReceipt = await gasEstimation.verboseWaitForTransaction(tx);
      console.log("setValue gasEstimate", gasEstimate.toString());
      console.log("setValue gasUsed    ", txReceipt.gasUsed.toString());

      gasEstimate = await gasEstimation.estimate.setValueWithEstimate(2, { gasLimit: 2000000, gasPrice: 1 });
      tx = await gasEstimation.setValueWithEstimate(2, { gasLimit: 2000000, gasPrice: 1 });
      txReceipt = await gasEstimation.verboseWaitForTransaction(tx);
      console.log("setValueWithEstimate gasEstimate", gasEstimate.toString());
      console.log("setValueWithEstimate gasUsed    ", txReceipt.gasUsed.toString());
    });
  });
});
