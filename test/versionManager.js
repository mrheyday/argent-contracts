/* global artifacts */
const ethers = require("ethers");

const GuardianManager = artifacts.require("GuardianManager");
const LockStorage = artifacts.require("LockStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const RelayerManager = artifacts.require("RelayerManager");
const VersionManager = artifacts.require("VersionManager");
const Registry = artifacts.require("ModuleRegistry");
const TestFeature = artifacts.require("TestFeature");

const { assertRevert } = require("../utils/utilities.js");
const RelayManager = require("../utils/relay-manager");

contract("VersionManager", (accounts) => {
  const manager = new RelayManager(accounts);
  const owner = accounts[1];

  let wallet;
  let walletImplementation;
  let lockStorage;
  let guardianStorage;
  let guardianManager;
  let relayerManager;
  let versionManager;
  let testFeature;

  before(async () => {
    walletImplementation = await BaseWallet.new();
  });

  beforeEach(async () => {
    const registry = await Registry.new();
    lockStorage = await LockStorage.new();
    guardianStorage = await GuardianStorage.new();
    versionManager = await VersionManager.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    relayerManager = await RelayerManager.new(
      lockStorage.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      versionManager.address);
    guardianManager = await GuardianManager.new(
      lockStorage.address,
      guardianStorage.address,
      versionManager.address,
      24,
      12);
    testFeature = await TestFeature.new(
      lockStorage.address,
      versionManager.address,
      true,
      42);
    await versionManager.addVersion([guardianManager.address, relayerManager.address, testFeature.address], []);
    manager.setRelayerManager(relayerManager);

    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
    await wallet.init(owner, [versionManager.address]);
    await versionManager.upgradeWallet(wallet.address, await versionManager.lastVersion(), { from: owner });
  });

  describe("VersionManager owner", () => {
    it("should not let the VersionManager owner add a storage twice", async () => {
      await assertRevert(versionManager.addStorage(lockStorage.address), "VM: storage already added");
    });

    it("should not let the VersionManager owner add an inconsistent version", async () => {
      // Should fail: the _featuresToInit array includes a feature not listed in the _features array
      await assertRevert(
        versionManager.addVersion([relayerManager.address], [guardianManager.address]),
        "VM: invalid _featuresToInit",
      );
    });

    it("should not let the VersionManager owner set an invalid minVersion", async () => {
      const lastVersion = await versionManager.lastVersion();

      await assertRevert(
        versionManager.setMinVersion(0),
        "VM: invalid _minVersion",
      );

      await assertRevert(
        versionManager.setMinVersion(lastVersion.addn(1)),
        "VM: invalid _minVersion",
      );
    });
  });

  describe("Wallet owner", () => {
    it("should not let the relayer call a forbidden method", async () => {
      await assertRevert(
        manager.relay(versionManager, "setOwner", [wallet.address, owner], wallet, [owner]),
        "VM: unknown method",
      );
    });

    it("should fail to upgrade a wallet when already on the last version", async () => {
      const lastVersion = await versionManager.lastVersion();
      await assertRevert(
        versionManager.upgradeWallet(wallet.address, lastVersion, { from: owner }),
        "VM: already on new version",
      );
    });

    it("should fail to upgrade a wallet to a version lower than minVersion", async () => {
      const badVersion = await versionManager.lastVersion();
      await versionManager.addVersion([], []);
      await versionManager.setMinVersion(await versionManager.lastVersion());

      await assertRevert(
        versionManager.upgradeWallet(wallet.address, badVersion, { from: owner }),
        "VM: invalid _toVersion",
      );
    });

    it("should not let a feature call an unauthorised storage", async () => {
      // Note: we are calling the deprecated GuardianStorage.setLock so this particular method gets touched by coverage
      const data1 = guardianStorage.contract.methods.setLock(wallet.address, 1).encodeABI();

      await testFeature.invokeStorage(wallet.address, guardianStorage.address, data1, { from: owner });
      let lock = await guardianStorage.getLock(wallet.address);
      assert.isTrue(lock.eq(1), "Lock should have been set");
      const data0 = guardianStorage.contract.methods.setLock(wallet.address, 0).encodeABI();

      await testFeature.invokeStorage(wallet.address, guardianStorage.address, data0, { from: owner });
      lock = await guardianStorage.getLock(wallet.address);
      assert.isTrue(lock.eq(0), "Lock should have been unset");

      const newGuardianStorage = await GuardianStorage.new(); // not authorised in VersionManager
      await assertRevert(
        testFeature.invokeStorage(wallet.address, newGuardianStorage.address, data1, { from: owner }),
        "VM: invalid storage invoked",
      );
      lock = await newGuardianStorage.getLock(wallet.address);
      assert.isTrue(lock.eq(0), "Lock should not be set");
    });
  });
});
