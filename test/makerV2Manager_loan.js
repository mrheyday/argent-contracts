/* global artifacts */

const ethers = require("ethers");
const {
  bigNumToBytes32, ETH_TOKEN, parseLogs, hasEvent, increaseTime, getBalance
} = require("../utils/utilities.js");
const {
  deployMaker, deployUniswap, RAY, ETH_PER_DAI, ETH_PER_MKR,
} = require("../utils/defi-deployer");

const { parseEther, formatBytes32String } = ethers.utils;
const { AddressZero } = ethers.constants;

const GemJoin = artifacts.require("GemJoin");
const Registry = artifacts.require("ModuleRegistry");

const MakerV2Manager = artifacts.require("MakerV2Manager");
const UpgradedMakerV2Manager = artifacts.require("TestUpgradedMakerV2Manager");
const MakerRegistry = artifacts.require("MakerRegistry");
const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const FakeWallet = artifacts.require("FakeWallet");
const GuardianStorage = artifacts.require("GuardianStorage");
const LockStorage = artifacts.require("LockStorage");
const TransferStorage = artifacts.require("TransferStorage");
const LimitStorage = artifacts.require("LimitStorage");
const TokenPriceRegistry = artifacts.require("TokenPriceRegistry");
const TransferManager = artifacts.require("TransferManager");
const BadFeature = artifacts.require("TestFeature");
const RelayerManager = artifacts.require("RelayerManager");
const VersionManager = artifacts.require("VersionManager");

contract("MakerV2Loan", (accounts) => {
  const manager = new RelayManager();

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const owner2 = accounts[2];

  let sai;
  let dai;
  let gov;
  let bat;
  let weth;
  let vat;
  let batJoin;
  let cdpManager;
  let pot;
  let jug;
  let migration;
  let transferManager;
  let guardianStorage;
  let lockStorage;
  let makerV2;
  let wallet;
  let walletImplementation;
  let walletAddress;
  let makerRegistry;
  let uniswapFactory;
  let relayerManager;
  let versionManager;

  before(async () => {
    // Deploy Maker
    const mk = await deployMaker(infrastructure);
    [sai, dai, gov, bat, weth, vat, batJoin, cdpManager, pot, jug, migration] = [
      mk.sai, mk.dai, mk.gov, mk.bat, mk.weth, mk.vat, mk.batJoin, mk.cdpManager, mk.pot, mk.jug, mk.migration,
    ];
    const { wethJoin } = mk;

    // Deploy Uniswap
    const uni = await deployUniswap(manager, infrastructure, [gov, dai], [ETH_PER_MKR, ETH_PER_DAI]);
    uniswapFactory = uni.uniswapFactory;

    // Deploy MakerV2Manager
    const registry = await Registry.new();
    guardianStorage = await GuardianStorage.new();
    lockStorage = await LockStorage.new();
    versionManager = await VersionManager.new(
      registry.contractAddress,
      lockStorage.contractAddress,
      guardianStorage.contractAddress,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);

    makerRegistry = await MakerRegistry.new(vat.contractAddress);
    await makerRegistry.addCollateral(wethJoin.contractAddress);
    makerV2 = await MakerV2Manager.new(
      lockStorage.contractAddress,
      migration.contractAddress,
      pot.contractAddress,
      jug.contractAddress,
      makerRegistry.contractAddress,
      uniswapFactory.contractAddress,
      versionManager.contractAddress,
    );

    // Deploy TransferManager
    const transferStorage = await TransferStorage.new();
    const limitStorage = await LimitStorage.new();
    const tokenPriceRegistry = await TokenPriceRegistry.new();
    transferManager = await TransferManager.new(
      lockStorage.contractAddress,
      transferStorage.contractAddress,
      limitStorage.contractAddress,
      tokenPriceRegistry.contractAddress,
      versionManager.contractAddress,
      3600,
      3600,
      10000,
      AddressZero,
      AddressZero,
    );

    walletImplementation = await BaseWallet.new();

    relayerManager = await RelayerManager.new(
      lockStorage.contractAddress,
      guardianStorage.contractAddress,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      versionManager.contractAddress);
    manager.setRelayerManager(relayerManager);

    await versionManager.addVersion([
      makerV2.contractAddress,
      transferManager.contractAddress,
      relayerManager.contractAddress,
    ], []);
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);

    await wallet.init(owner, [versionManager.contractAddress]);
    await versionManager.from(owner).upgradeWallet(wallet.contractAddress, await versionManager.lastVersion());
    walletAddress = wallet.contractAddress;
    await wallet.send(parseEther("2.0"));
    await dai["mint(address,uint256)"](walletAddress, parseEther("10"));
  });

  async function getTestAmounts(tokenAddress) {
    const tokenAddress_ = (tokenAddress === ETH_TOKEN) ? weth.address : tokenAddress;
    const { ilk } = await makerRegistry.collaterals(tokenAddress_);
    const { spot, dust } = await vat.ilks(ilk);
    const daiAmount = dust.div(RAY);
    const collateralAmount = dust.div(spot).mul(2);
    return { daiAmount, collateralAmount };
  }

  async function testOpenLoan({
    collateralAmount, daiAmount, relayed, collateral = { contractAddress: ETH_TOKEN },
  }) {
    const beforeCollateral = (collateral.address === ETH_TOKEN)
      ? await getBalance(walletAddress)
      : await collateral.balanceOf(walletAddress);

    const beforeDAI = await dai.balanceOf(walletAddress);
    const beforeDAISupply = await dai.totalSupply();

    const method = "openLoan";
    const params = [walletAddress, collateral.address, collateralAmount, dai.address, daiAmount];
    let txReceipt;
    if (relayed) {
      txReceipt = await manager.relay(makerV2, method, params, wallet, [owner]);
      const { success } = (await parseLogs(txReceipt, relayerManager, "TransactionExecuted"))[0];
      assert.isTrue(success, "Relayed tx should succeed");
    } else {
      txReceipt = await (await makerV2.from(owner)[method](...params, { gasLimit: 2000000 })).wait();
    }
    const loanId = (await parseLogs(txReceipt, makerV2, "LoanOpened"))[0]._loanId;
    assert.isDefined(loanId, "Loan ID should be defined");

    const afterCollateral = (collateral.address === ETH_TOKEN)
      ? await getBalance(walletAddress)
      : await collateral.balanceOf(walletAddress);
    const afterDAI = await dai.balanceOf(walletAddress);
    const afterDAISupply = await dai.totalSupply();

    assert.equal(
      beforeCollateral.sub(afterCollateral).toString(),
      collateralAmount.toString(),
      `wallet should have ${collateralAmount} less collateral (relayed: ${relayed})`,
    );
    assert.equal(
      afterDAI.sub(beforeDAI).toString(),
      daiAmount.toString(),
      `wallet should have ${daiAmount} more DAI (relayed: ${relayed})`,
    );
    assert.equal(
      afterDAISupply.sub(beforeDAISupply).toString(),
      daiAmount.toString(),
      `${daiAmount} DAI should have been minted (relayed: ${relayed})`,
    );

    return loanId;
  }

  describe("Open Loan", () => {
    let daiAmount;
    let collateralAmount;
    before(async () => {
      const testAmounts = await getTestAmounts(ETH_TOKEN);
      daiAmount = testAmounts.daiAmount;
      collateralAmount = testAmounts.collateralAmount;
    });

    it("should open a Loan (blockchain tx)", async () => {
      await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
    });

    it("should open a Loan (relayed tx)", async () => {
      await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
    });

    it("should open>close>reopen a Loan (blockchain tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await makerV2.from(owner).closeLoan(walletAddress, loanId, { gasLimit: 4500000 });
      await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
    });

    it("should open>close>reopen a Loan (relayed tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
      await (await makerV2.from(owner).closeLoan(walletAddress, loanId, { gasLimit: 4500000 })).wait();
      await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
    });

    it("should not open a loan for the wrong debt token", async () => {
      await assert.revertWith(
        makerV2.from(owner).openLoan(walletAddress, ETH_TOKEN, collateralAmount, sai.address, daiAmount),
        "MV2: debt token not DAI",
      );
    });

    it("should not open a loan for an unsupported collateral token", async () => {
      await assert.revertWith(
        makerV2.from(owner).openLoan(walletAddress, sai.address, collateralAmount, dai.address, daiAmount),
        "MV2: unsupported collateral",
      );
    });
  });

  async function testChangeCollateral({
    loanId, collateralAmount, add, relayed, collateral = { contractAddress: ETH_TOKEN }, makerV2Manager = makerV2,
  }) {
    const beforeCollateral = (collateral.address === ETH_TOKEN)
      ? await getBalance(walletAddress)
      : await collateral.balanceOf(walletAddress);

    const method = add ? "addCollateral" : "removeCollateral";
    const params = [wallet.address, loanId, collateral.address, collateralAmount];
    if (relayed) {
      const txR = await manager.relay(makerV2Manager, method, params, wallet, [owner]);
      assert.isTrue(txR.events.find((e) => e.event === "TransactionExecuted").args.success, "Relayed tx should succeed");
    } else {
      await makerV2Manager.from(owner)[method](...params, { gasLimit: 2000000 });
    }

    const afterCollateral = (collateral.address === ETH_TOKEN)
      ? await getBalance(walletAddress)
      : await collateral.balanceOf(walletAddress);

    const expectedCollateralChange = collateralAmount.mul(add ? -1 : 1).toString();
    assert.equal(
      afterCollateral.sub(beforeCollateral).toString(),
      expectedCollateralChange,
      `wallet collateral should have changed by ${expectedCollateralChange} (relayed: ${relayed})`,
    );
  }

  describe("Add/Remove Collateral", () => {
    let daiAmount;
    let collateralAmount;

    before(async () => {
      const testAmounts = await getTestAmounts(ETH_TOKEN);
      daiAmount = testAmounts.daiAmount;
      collateralAmount = testAmounts.collateralAmount;
    });

    it("should add collateral (blockchain tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await testChangeCollateral({
        loanId, collateralAmount: parseEther("0.010"), add: true, relayed: false,
      });
    });

    it("should add collateral (relayed tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
      await testChangeCollateral({
        loanId, collateralAmount: parseEther("0.010"), add: true, relayed: true,
      });
    });

    it("should not add collateral for the wrong loan owner", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      const proxy = await Proxy.new(walletImplementation.address);
      const wallet2 = await BaseWallet.at(proxy.address);

      await wallet2.init(owner2, [versionManager.contractAddress]);
      await assert.revertWith(
        makerV2.from(owner2).addCollateral(wallet2.address, loanId, ETH_TOKEN, parseEther("0.010")),
        "MV2: unauthorized loanId",
      );
    });

    it("should remove collateral (blockchain tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await testChangeCollateral({
        loanId, collateralAmount: parseEther("0.010"), add: false, relayed: false,
      });
    });

    it("should remove collateral (relayed tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
      await testChangeCollateral({
        loanId, collateralAmount: parseEther("0.010"), add: false, relayed: true,
      });
    });

    it("should not remove collateral with invalid collateral amount", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await assert.revertWith(
        makerV2.from(owner).removeCollateral(walletAddress, loanId, ETH_TOKEN, ethers.BigNumber.from(2).pow(255)),
        "MV2: int overflow",
      );
    });

    it("should not remove collateral for the wrong loan owner", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      const proxy = await Proxy.new(walletImplementation.address);
      const wallet2 = await BaseWallet.at(proxy.address);

      await wallet2.init(owner2, [versionManager.contractAddress]);
      await assert.revertWith(
        makerV2.from(owner2).removeCollateral(wallet2.address, loanId, ETH_TOKEN, parseEther("0.010")),
        "MV2: unauthorized loanId",
      );
    });
  });

  async function testChangeDebt({
    loanId, daiAmount, add, relayed,
  }) {
    const beforeDAI = await dai.balanceOf(wallet.address);
    const beforeETH = await getBalance(wallet.address);
    const method = add ? "addDebt" : "removeDebt";
    const params = [wallet.address, loanId, dai.address, daiAmount];
    if (relayed) {
      const txR = await manager.relay(makerV2, method, params, { contractAddress: walletAddress }, [owner]);
      assert.isTrue(txR.events.find((e) => e.event === "TransactionExecuted").args.success, "Relayed tx should succeed");
    } else {
      await makerV2.from(owner)[method](...params, { gasLimit: 2000000 });
    }
    const afterDAI = await dai.balanceOf(wallet.address);
    const afterETH = await getBalance(wallet.address);
    if (add) {
      assert.equal(
        afterDAI.sub(beforeDAI).toString(),
        daiAmount.toString(),
        `wallet DAI should have increased by ${daiAmount.toString()} (relayed: ${relayed})`,
      );
    } else {
      assert.isTrue(
        afterDAI.lt(beforeDAI) || afterETH.lt(beforeETH),
        `wallet DAI or ETH should have decreased (relayed: ${relayed})`,
      );
    }
  }

  describe("Increase Debt", () => {
    let daiAmount;
    let collateralAmount;

    before(async () => {
      const testAmounts = await getTestAmounts(ETH_TOKEN);
      daiAmount = testAmounts.daiAmount;
      collateralAmount = testAmounts.collateralAmount;
    });

    it("should increase debt (blockchain tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await testChangeDebt({
        loanId, daiAmount: parseEther("0.5"), add: true, relayed: false,
      });
    });

    it("should increase debt (relayed tx)", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
      await testChangeDebt({
        loanId, daiAmount: parseEther("0.5"), add: true, relayed: true,
      });
    });

    it("should not increase debt for the wrong loan owner", async () => {
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      const proxy = await Proxy.new(walletImplementation.address);
      const wallet2 = await BaseWallet.at(proxy.address);

      await wallet2.init(owner2, [versionManager.contractAddress]);
      await assert.revertWith(
        makerV2.from(owner2).addDebt(wallet2.address, loanId, ETH_TOKEN, parseEther("0.010")),
        "MV2: unauthorized loanId",
      );
    });
  });

  async function testRepayDebt({ relayed }) {
    const { collateralAmount, daiAmount: daiAmount_ } = await getTestAmounts(ETH_TOKEN);
    const daiAmount = daiAmount_.add(parseEther("0.3"));

    const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed });
    await increaseTime(3); // wait 3 seconds
    const beforeDAI = await dai.balanceOf(wallet.address);
    const beforeETH = await getBalance(wallet.address);
    await testChangeDebt({
      loanId, daiAmount: parseEther("0.2"), add: false, relayed,
    });

    const afterDAI = await dai.balanceOf(wallet.address);
    const afterETH = await getBalance(wallet.address);

    assert.isTrue(afterDAI.lt(beforeDAI) && afterETH.eq(beforeETH), "should have less DAI");
  }

  describe("Repay Debt", () => {
    it("should repay debt (blockchain tx)", async () => {
      await testRepayDebt({ relayed: false });
    });

    it("should repay debt (relayed tx)", async () => {
      await testRepayDebt({ relayed: true });
    });

    it("should not repay debt when only dust left", async () => {
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await assert.revertWith(
        makerV2.from(owner).removeDebt(walletAddress, loanId, dai.address, daiAmount.sub(1)),
        "MV2: repay less or full",
      );
    });

    it("should not repay debt for the wrong loan owner", async () => {
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      const proxy = await Proxy.new(walletImplementation.address);
      const wallet2 = await BaseWallet.at(proxy.address);

      await wallet2.init(owner2, [versionManager.contractAddress]);
      await assert.revertWith(
        makerV2.from(owner2).removeDebt(wallet2.address, loanId, ETH_TOKEN, parseEther("0.010")),
        "MV2: unauthorized loanId",
      );
    });
  });

  async function testCloseLoan({ relayed }) {
    const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
    const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed });
    // give some ETH to the wallet to be used for repayment
    await owner.send({ to: walletAddress, value: collateralAmount.mul(2) });
    await increaseTime(3); // wait 3 seconds
    const beforeDAI = await dai.balanceOf(wallet.contractAddress);
    const method = "closeLoan";
    const params = [wallet.address, loanId];
    if (relayed) {
      const txR = await manager.relay(makerV2, method, params, { contractAddress: walletAddress }, [owner]);
      assert.isTrue(txR.events.find((e) => e.event === "TransactionExecuted").args.success, "Relayed tx should succeed");
    } else {
      await makerV2.from(owner)[method](...params, { gasLimit: 3000000 });
    }
    const afterDAI = await dai.balanceOf(wallet.contractAddress);

    assert.isTrue(afterDAI.lt(beforeDAI), "should have spent some DAI");
  }

  describe("Close Vaults", () => {
    it("should close a vault (blockchain tx)", async () => {
      await testCloseLoan({ relayed: false });
    });

    it("should close a vault (relayed tx)", async () => {
      await testCloseLoan({ relayed: true });
    });

    it("should not close a vault for the wrong loan owner", async () => {
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      const loanId = await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      const proxy = await Proxy.new(walletImplementation.address);
      const wallet2 = await BaseWallet.at(proxy.address);

      await wallet2.init(owner2, [versionManager.contractAddress]);
      await assert.revertWith(
        makerV2.from(owner2).closeLoan(wallet2.address, loanId),
        "MV2: unauthorized loanId",
      );
    });
  });

  describe("MakerRegistry", () => {
    it("should add a new collateral token", async () => {
      const numCollateralBefore = (await makerRegistry.getCollateralTokens()).length;
      await makerRegistry.addCollateral(batJoin.address);
      const numCollateralAfter = (await makerRegistry.getCollateralTokens()).length;
      assert.equal(numCollateralAfter, numCollateralBefore + 1, "A new collateral should have been added");
      await makerRegistry.removeCollateral(bat.address); // cleanup
    });

    it("should open a loan with a newly added collateral token", async () => {
      await makerRegistry.addCollateral(batJoin.address);
      const { daiAmount, collateralAmount } = await getTestAmounts(bat.address);
      await bat["mint(address,uint256)"](walletAddress, collateralAmount);
      await testOpenLoan({
        collateralAmount, daiAmount, collateral: bat, relayed: false,
      });
      await makerRegistry.removeCollateral(bat.address); // cleanup
    });

    it("should not add a collateral when Join is not in the Vat", async () => {
      const badJoin = await GemJoin.new(vat.address, formatBytes32String("BAD"), bat.address);
      await assert.revertWith(makerRegistry.addCollateral(badJoin.address), "MR: _joinAdapter not authorised in vat");
    });

    it("should not add a duplicate collateral", async () => {
      await makerRegistry.addCollateral(batJoin.address);
      await assert.revertWith(makerRegistry.addCollateral(batJoin.address), "MR: collateral already added");
      await makerRegistry.removeCollateral(bat.address); // cleanup
    });

    it("should remove a collateral", async () => {
      const numCollateralBefore = (await makerRegistry.getCollateralTokens()).length;
      await makerRegistry.addCollateral(batJoin.address);
      await makerRegistry.removeCollateral(bat.address);
      const numCollateralAfter = (await makerRegistry.getCollateralTokens()).length;
      assert.equal(numCollateralAfter, numCollateralBefore, "The added collateral should have been removed");
    });

    it("should not remove a non-existing collateral", async () => {
      await assert.revertWith(makerRegistry.removeCollateral(bat.address), "MR: collateral does not exist");
    });
  });

  describe("Acquiring a wallet's vault", () => {
    async function testAcquireVault({ relayed }) {
      // Create the vault with `owner` as owner
      const { ilk } = await makerRegistry.collaterals(weth.contractAddress);
      const txR = await (await cdpManager.from(owner).open(ilk, owner)).wait();
      const vaultId = txR.events.find((e) => e.event === "NewCdp").args.cdp;
      // Transfer the vault to the wallet
      await cdpManager.from(owner).give(vaultId, walletAddress);
      // Transfer the vault to the feature
      const loanId = bigNumToBytes32(vaultId);
      const method = "acquireLoan";
      const params = [walletAddress, loanId];
      let txReceipt;
      if (relayed) {
        txReceipt = await manager.relay(makerV2, method, params, { contractAddress: walletAddress }, [owner]);
        assert.isTrue(txReceipt.events.find((e) => e.event === "TransactionExecuted").args.success, "Relayed tx should succeed");
      } else {
        const tx = await makerV2.from(owner)[method](...params, { gasLimit: 1000000 });
        txReceipt = await makerV2.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await hasEvent(txReceipt, makerV2, "LoanAcquired"), "should have generated LoanAcquired event");

      // The loanId held by the MakerV2Manager will be different from the transferred vault id, in case the latter was merged into an existing vault
      const featureLoanId = await makerV2.loanIds(walletAddress, ilk);
      // Add some collateral and debt
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      await testChangeCollateral({
        loanId: featureLoanId, collateralAmount, add: true, relayed, makerV2,
      });
      await testChangeDebt({
        loanId: featureLoanId, daiAmount, add: true, relayed,
      });
    }

    it("should transfer a vault from a wallet to the feature (blockchain tx)", async () => {
      await testAcquireVault({ relayed: false });
    });

    it("should transfer a vault from a wallet to the feature (relayed tx)", async () => {
      await testAcquireVault({ relayed: true });
    });

    it("should not transfer a vault that is not owned by the wallet", async () => {
      // Create the vault with `owner` as owner
      const { ilk } = await makerRegistry.collaterals(weth.address);
      const txR = await (await cdpManager.from(owner).open(ilk, owner)).wait();
      const vaultId = txR.events.find((e) => e.event === "NewCdp").args.cdp;
      const loanId = bigNumToBytes32(vaultId);
      // We are NOT transferring the vault from the owner to the wallet
      await assert.revertWith(
        makerV2.from(owner).acquireLoan(walletAddress, loanId), "MV2: wrong vault owner",
      );
    });

    it("should not transfer a vault that is not given to the feature", async () => {
      // Deploy a fake wallet
      const fakeWallet = await FakeWallet.new(false, AddressZero, 0, "0x00");
      await fakeWallet.init(owner, [versionManager.contractAddress]);
      await versionManager.from(owner).upgradeWallet(fakeWallet.contractAddress, await versionManager.lastVersion());
      // Create the vault with `owner` as owner
      const { ilk } = await makerRegistry.collaterals(weth.address);
      const txR = await (await cdpManager.from(owner).open(ilk, owner)).wait();
      const vaultId = txR.events.find((e) => e.event === "NewCdp").args.cdp;
      const loanId = bigNumToBytes32(vaultId);
      // Transfer the vault to the fake wallet
      await cdpManager.from(owner).give(vaultId, fakeWallet.address);
      await assert.revertWith(
        makerV2.from(owner).acquireLoan(fakeWallet.address, loanId), "MV2: failed give",
      );
    });

    it("should transfer (merge) a vault when already holding a vault in the feature (blockchain tx)", async () => {
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      await testOpenLoan({ collateralAmount, daiAmount, relayed: false });
      await testAcquireVault({ relayed: false });
    });

    it("should transfer (merge) a vault when already holding a vault in the feature (relayed tx)", async () => {
      const { collateralAmount, daiAmount } = await getTestAmounts(ETH_TOKEN);
      await testOpenLoan({ collateralAmount, daiAmount, relayed: true });
      await testAcquireVault({ relayed: true });
    });

    it("should not allow reentrancy in acquireLoan", async () => {
      // Deploy a fake wallet capable of reentrancy
      const acquireLoanCallData = makerV2.contract.interface.functions.acquireLoan.encode([AddressZero, bigNumToBytes32(ethers.BigNumber.from(0))]);
      const fakeWallet = await FakeWallet.new(true, makerV2.contractAddress, 0, acquireLoanCallData);
      await fakeWallet.init(owner, [versionManager.contractAddress]);
      await versionManager.from(owner).upgradeWallet(fakeWallet.contractAddress, await versionManager.lastVersion());
      // Create the vault with `owner` as owner
      const { ilk } = await makerRegistry.collaterals(weth.address);
      const txR = await (await cdpManager.from(owner).open(ilk, owner)).wait();
      const vaultId = txR.events.find((e) => e.event === "NewCdp").args.cdp;
      const loanId = bigNumToBytes32(vaultId);
      // Transfer the vault to the fake wallet
      await cdpManager.from(owner).give(vaultId, fakeWallet.address);
      await assert.revertWith(
        makerV2.from(owner).acquireLoan(fakeWallet.address, loanId), "MV2: reentrant call",
      );
    });
  });

  describe("Upgrade of MakerV2Manager", () => {
    let upgradedMakerV2;
    let daiAmount;
    let collateralAmount;

    beforeEach(async () => {
      // Generate test amounts
      const testAmounts = await getTestAmounts(ETH_TOKEN);
      daiAmount = testAmounts.daiAmount;
      collateralAmount = testAmounts.collateralAmount;

      // Deploy and register the upgraded MakerV2 feature
      upgradedMakerV2 = await UpgradedMakerV2Manager.new(
        lockStorage.contractAddress,
        migration.contractAddress,
        pot.contractAddress,
        jug.contractAddress,
        makerRegistry.contractAddress,
        uniswapFactory.contractAddress,
        makerV2.contractAddress,
        versionManager.contractAddress,
        { gasLimit: 10700000 },
      );

      // Adding BAT to the registry of supported collateral tokens
      if (!(await makerRegistry.collaterals(bat.address)).exists) {
        await makerRegistry.addCollateral(batJoin.address);
      }
    });

    async function testUpgradeModule({ relayed, withBatVault = false }) {
      // Open a WETH vault with the old MakerV2 feature
      const loanId1 = await testOpenLoan({ collateralAmount, daiAmount, relayed });
      let loanId2;
      if (withBatVault) {
        // Open a BAT vault with the old MakerV2 feature
        const batTestAmounts = await getTestAmounts(bat.contractAddress);
        await bat["mint(address,uint256)"](walletAddress, batTestAmounts.collateralAmount.add(parseEther("0.01")));
        loanId2 = await testOpenLoan({
          collateralAmount: batTestAmounts.collateralAmount,
          daiAmount: batTestAmounts.daiAmount,
          collateral: bat,
          relayed,
        });
      }

      // Add the upgraded feature
      await versionManager.addVersion([
        upgradedMakerV2.contractAddress,
        transferManager.contractAddress,
        relayerManager.contractAddress,
      ], [upgradedMakerV2.contractAddress]);
      const method = "upgradeWallet";
      const lastVersion = await versionManager.lastVersion();
      const params = [walletAddress, lastVersion];
      if (relayed) {
        const txR = await manager.relay(versionManager, method, params, wallet, [owner]);
        assert.isTrue(txR.events.find((e) => e.event === "TransactionExecuted").args.success, "Relayed tx should succeed");
      } else {
        await versionManager.from(owner)[method](...params, { gasLimit: 2000000 });
      }
      // Make sure that the vaults can be manipulated from the upgraded feature
      await testChangeCollateral({
        loanId: loanId1,
        collateralAmount: parseEther("0.010"),
        add: true,
        relayed,
        makerV2Manager: upgradedMakerV2,
      });
      await upgradedMakerV2.from(owner).closeLoan(walletAddress, loanId1, { gasLimit: 4500000 });

      if (withBatVault) {
        await testChangeCollateral({
          loanId: loanId2,
          collateralAmount: parseEther("0.010"),
          add: true,
          relayed,
          collateral: bat,
          makerV2Manager: upgradedMakerV2,
        });
        await upgradedMakerV2.from(owner).closeLoan(walletAddress, loanId2, { gasLimit: 4500000 });
      }

      // reset the last version to the default bundle
      await versionManager.addVersion([
        makerV2.contractAddress,
        transferManager.contractAddress,
        relayerManager.contractAddress,
      ], []);
    }

    it("should move a vault after a feature upgrade (blockchain tx)", async () => {
      await testUpgradeModule({ relayed: false });
    });

    it("should move a vault after a feature upgrade (relayed tx)", async () => {
      await testUpgradeModule({ relayed: true });
    });

    it("should move 2 vaults after a feature upgrade (blockchain tx)", async () => {
      await testUpgradeModule({ withBatVault: true, relayed: false });
    });

    it("should move 2 vaults after a feature upgrade (relayed tx)", async () => {
      await testUpgradeModule({ withBatVault: true, relayed: true });
    });

    it("should not allow non-feature to give vault", async () => {
      await assert.revertWith(makerV2.from(owner).giveVault(walletAddress, formatBytes32String("")), "BF: must be a wallet feature");
    });

    it("should not allow (fake) feature to give unowned vault", async () => {
      // Deploy a (fake) bad feature
      const badFeature = await BadFeaturenew(lockStorage.contractAddress, versionManager.contractAddress, false, 0);

      // Add the bad feature to the wallet
      await versionManager.addVersion([
        badFeature.contractAddress,
        transferManager.contractAddress,
        relayerManager.contractAddress,
      ], []);
      const lastVersion = await versionManager.lastVersion();
      await versionManager.from(owner).upgradeWallet(walletAddress, lastVersion, { gasLimit: 2000000 });
      // Use the bad module to attempt a bad giveVault call
      const callData = makerV2.contract.interface.functions.giveVault.encode([walletAddress, bigNumToBytes32(ethers.BigNumber.from(666))]);
      await assert.revertWith(badFeature.from(owner).callContract(makerV2.contractAddress, 0, callData), "MV2: unauthorized loanId");
    });
  });
});
