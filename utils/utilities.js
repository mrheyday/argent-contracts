const readline = require("readline");
const ethers = require("ethers");
const ethUtil = require('ethereumjs-util');
const fs = require('fs');

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

module.exports = {

  ETH_TOKEN,

  namehash(_name) {
    return ethers.utils.namehash(_name);
  },

  sha3: (input) => {
    if (ethers.utils.isHexString(input)) {
      return ethers.utils.keccak256(input);
    }
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(input));
  },

  asciiToBytes32: (input) => ethers.utils.formatBytes32String(input), // return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(input));

  bigNumToBytes32: (input) => ethers.utils.hexZeroPad(input.toHexString(), 32),

  waitForUserInput: (text) => new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(text, (answer) => {
      resolve(answer);
      rl.close();
    });
  }),

  signOffchain: async (signers, from, to, value, data, chainId, nonce, gasPrice, gasLimit, refundToken, refundAddress) => {
    const input = `0x${[
      "0x19",
      "0x00",
      from,
      to,
      ethers.utils.hexZeroPad(ethers.utils.hexlify(value), 32),
      data,
      ethers.utils.hexZeroPad(ethers.utils.hexlify(chainId), 32),
      nonce,
      ethers.utils.hexZeroPad(ethers.utils.hexlify(gasPrice), 32),
      ethers.utils.hexZeroPad(ethers.utils.hexlify(gasLimit), 32),
      refundToken,
      refundAddress,
    ].map((hex) => hex.slice(2)).join("")}`;
    
    var dataBuff = ethUtil.toBuffer(ethers.utils.keccak256(input));
    var msgHashBuff = ethUtil.hashPersonalMessage(dataBuff);

    const accountsJson = JSON.parse(fs.readFileSync("./ganache-accounts.json", "utf8"));
    const sigs = `0x${signers.map((signer) => {
      const pkey = accountsJson.private_keys[signer.toLowerCase()];
      const sig = ethUtil.ecsign(msgHashBuff, Buffer.from(pkey, "hex"));
      const signature = ethUtil.toRpcSig(sig.v, sig.r, sig.s);
      const split = ethers.utils.splitSignature(signature);
      return ethers.utils.joinSignature(split).slice(2);
    }).join("")}`;
    return sigs;
  },

  sortWalletByAddress(wallets) {
    return wallets.sort((s1, s2) => {
      const bn1 = ethers.BigNumber.from(s1);
      const bn2 = ethers.BigNumber.from(s2);
      if (bn1.lt(bn2)) return -1;
      if (bn1.gt(bn2)) return 1;    
      return 0;
    });
  },

  // Parses the RelayerModule.execute receipt to decompose the success value of the transaction
  // and additionally if an error was raised in the sub-call to optionally return that
  parseRelayReceipt(txReceipt) {
    const { args } = txReceipt.events.find((l) => l.event === "TransactionExecuted");

    let errorBytes;
    if (args.returnData.startsWith("0x08c379a0")) {
      // Remove the encoded error signatures 08c379a0
      const noErrorSelector = `0x${args.returnData.slice(10)}`;
      const errorBytesArray = ethers.utils.defaultAbiCoder.decode(["bytes"], noErrorSelector);
      errorBytes = errorBytesArray[0]; // eslint-disable-line prefer-destructuring
    } else {
      errorBytes = args.returnData;
    }
    const error = ethers.utils.toUtf8String(errorBytes);
    return { success: args.success, error };
  },

  parseLogs(txReceipt, contract, eventName) {
    const filter = txReceipt.logs.filter((e) => (
      e.topics.find((t) => (
        contract.interface.events[eventName].topic === t
      )) !== undefined
    ));
    const res = [];
    for (const f of filter) {
      res.push(contract.interface.events[eventName].decode(f.data, f.topics));
    }
    return res;
  },

  async hasEvent(txReceipt, eventName) {
    const event = txReceipt.logs.find((e) => e.event === eventName);
    return expect(event, "Event does not exist in recept").to.exist;
  },

  versionFingerprint(modules) {
    const concat = modules.map((module) => module.address).sort((m1, m2) => {
      const bn1 = ethers.BigNumber.from(m1);
      const bn2 = ethers.BigNumber.from(m2);
      if (bn1.lt(bn2)) {
        return 1;
      }
      if (bn1.gt(bn2)) {
        return -1;
      }
      return 0;
    }).reduce((prevValue, currentValue) => prevValue + currentValue.slice(2), "0x");
    return ethers.utils.keccak256(concat).slice(0, 10);
  },

  getRandomAddress() {
    return ethers.Wallet.createRandom().address;
  },

  generateSaltValue() {
    return ethers.utils.hexZeroPad(
      ethers.BigNumber.from(ethers.utils.randomBytes(32)).toHexString(),
      32,
    );
  },

  async getBalance(account) {
    const balance = await web3.eth.getBalance(account);
    return new ethers.BigNumber.from(balance);
  },

  async getTimestamp(blockNumber) {
    const blockN = !blockNumber ? "latest" : blockNumber;
    const { timestamp } = await web3.eth.getBlock(blockN);
    return timestamp;
  },

  async getNetworkId() {
    // if (this.network === "ganache" || this.network.endsWith("-fork")) {
    //   return 1; // ganache currently always uses 1 as chainId, see https://github.com/trufflesuite/ganache-core/issues/515
    // }
    const networkId = await web3.eth.net.getId();
    return networkId;
  },

  async increaseTime(seconds) {
    const networkId = await web3.eth.net.getId();

    if (networkId === "1597649375983") {
      await web3.currentProvider.send("evm_increaseTime", seconds);
      await web3.currentProvider.send("evm_mine");
    } else {
      return new Promise((res) => { setTimeout(res, seconds * 1000); });
    }
    return null;
  },

  async getNonceForRelay() {
    const block = await web3.eth.getBlockNumber();
    const timestamp = new Date().getTime();
    return `0x${ethers.utils.hexZeroPad(ethers.utils.hexlify(block), 16)
      .slice(2)}${ethers.utils.hexZeroPad(ethers.utils.hexlify(timestamp), 16).slice(2)}`;
  },

  async assertRevert(promise, revertMessage) {
    let reason;
    try {
      await promise;
      assert.fail(`Transaction succeeded, but expected error ${revertMessage}`);
    } catch (err) {
      ({ reason } = err);
      assert.equal(reason, revertMessage);
    }
  },

  async getAccount(index) {
    const accounts = await web3.eth.getAccounts();
    return accounts[index];
  }
};
