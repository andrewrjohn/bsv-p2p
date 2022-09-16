import EventEmitter from "events";
import Net from "net";
import Crypto from "crypto";
import { Block, Transaction } from "bsv-minimal";
import {
  Message,
  Headers,
  Inv,
  Version,
  GetData,
  Reject,
  Address,
} from "./messages";
import { MAGIC_NUMS, MAX_PER_MSG } from "./config";

interface Options {
  node: string;
  ticker?: string;
  stream?: boolean;
  validate?: boolean;
  autoReconnect?: boolean;
  disableExtmsg?: boolean;
  DEBUG_LOG?: boolean;
  MAGIC_NUM?: boolean | string;
}

export default class Peer extends EventEmitter {
  listenBlocks = false;
  connected = false;
  listenTxs = false;
  extmsg = false;
  disconnects = 0;
  timeoutConnect = 1000 * 30; // 30 seconds
  timeoutHeaders = 1000 * 30; // 30 seconds
  DEBUG_LOG = false;
  magic;
  node;
  ticker;
  stream;
  validate;
  autoReconnect;
  disableExtmsg;
  promises: Record<any, any>;
  internalEmitter;
  buffers;
  connectOptions?: object;
  socket?: Net.Socket | null;
  promiseConnect;
  promiseGetHeaders;

  constructor({
    node,
    ticker = "BSV",
    stream = true,
    validate = true,
    autoReconnect = true,
    disableExtmsg = false,
    DEBUG_LOG = false,
    MAGIC_NUM = false, // 4 byte Buffer
  }: Options) {
    super();
    if (!MAGIC_NUM) MAGIC_NUM = MAGIC_NUMS[ticker];
    if (!MAGIC_NUM) throw Error(`bsv-p2p: Missing MAGIC_NUM ${ticker}`);
    if (typeof node !== "string") throw Error(`Missing node address`);
    if (typeof MAGIC_NUM === "string") {
      this.magic = Buffer.from(MAGIC_NUM, "hex");
    } else if (Buffer.isBuffer(MAGIC_NUM)) {
      this.magic = MAGIC_NUM;
    } else {
      throw Error(`Invalid MAGIC_NUM`);
    }

    this.node = node;
    this.ticker = ticker;
    this.stream = stream;
    this.validate = validate;
    this.autoReconnect = autoReconnect;
    this.disableExtmsg = disableExtmsg;
    this.DEBUG_LOG = DEBUG_LOG;
    this.promises = {};
    this.internalEmitter = new EventEmitter();
    this.buffers = {
      data: [] as Buffer[],
      needed: 0,
      length: 0,
      block: null as any,
      chunkNum: 0,
    };
  }

  // TODO: Should command be any string or is there a finite number of options?
  sendMessage(command: string, payload?: Buffer | null, force = false) {
    if (!this.connected && !force) throw Error(`Not connected`);
    const { magic, extmsg } = this;
    const serialized = Message.write({ command, payload, magic, extmsg });
    this.socket?.write(serialized);
    this.DEBUG_LOG &&
      console.log(
        `bsv-p2p: Sent message ${command} ${
          payload ? payload.length : "0"
        } bytes`
      );
  }

  streamBlock(chunk: Buffer, start = false) {
    const { buffers, ticker, validate, node } = this;
    let stream;
    if (start) {
      const block = new Block({ validate });
      stream = block.addBufferChunk(chunk);
      if (!stream.header) return;
      buffers.block = block;
      buffers.chunkNum = 0;
    } else {
      stream = buffers.block.addBufferChunk(chunk);
    }
    const {
      finished,
      started,
      transactions,
      bytesRemaining,
      header,
      height,
      size,
      txCount,
    } = stream;
    stream.ticker = ticker;
    this.emit("transactions", { ...stream, node });
    const blockHash = header.getHash();
    this.emit("block_chunk", {
      node,
      num: buffers.chunkNum++,
      started,
      finished,
      transactions,
      header,
      ticker,
      chunk: finished ? chunk.slice(0, chunk.length - bytesRemaining) : chunk,
      blockHash,
      height,
      size,
      txCount,
    });
    if (finished) {
      if (bytesRemaining > 0) {
        const remaining = buffers.block.br.readAll();
        buffers.data = [remaining];
        buffers.length = remaining.length;
      } else {
        buffers.data = [];
        buffers.length = 0;
      }
      buffers.block = null;
      buffers.needed = 0;

      this.internalEmitter.emit(`block_${blockHash.toString("hex")}`, {
        ticker,
        blockHash,
        header,
        height,
        size,
      });
    }
  }

  async readMessage(buffer: Buffer) {
    const {
      node,
      magic,
      buffers,
      ticker,
      stream,
      validate,
      listenTxs,
      listenBlocks,
      extmsg,
    } = this;
    try {
      const message = Message.read({ buffer, magic, extmsg });
      const { command, payload, end, needed } = message;
      buffers.needed = needed;

      if (stream && command === "block") {
        this.streamBlock(payload, true);
      }
      if (needed) return;
      const remainingBuffer = buffer.slice(end);
      buffers.data = [remainingBuffer];
      buffers.length = remainingBuffer.length;
      buffers.needed = 0;

      this.DEBUG_LOG &&
        command !== "inv" &&
        console.log(
          `bsv-p2p: Received message`,
          command,
          payload && `${payload.length} bytes`
        );
      if (command === "ping") {
        this.sendMessage("pong", payload);
        this.emit("ping", { ticker, node });
      } else if (command === "pong") {
        const nonce = payload.toString("hex");
        this.internalEmitter.emit(`pong_${nonce}`);
        this.emit("pong", { ticker, node });
      } else if (command === "headers") {
        const headers = Headers.parseHeaders(payload);
        this.DEBUG_LOG &&
          console.log(`bsv-p2p: Received ${headers.length} headers`);
        this.internalEmitter.emit(`headers`, headers);
        this.emit(`headers`, { ticker, node, headers });
      } else if (command === "version") {
        this.sendMessage("verack", null, true);
        const version = Version.read(payload);
        if (!this.disableExtmsg) this.extmsg = version.version >= 70016; // Enable/disable extension messages based on node version
        this.DEBUG_LOG && console.log(`bsv-p2p: version`, version);
        this.emit(`version`, { ticker, node, version });
        this.internalEmitter.emit(`version`);
      } else if (command === "verack") {
        this.DEBUG_LOG && console.log(`bsv-p2p: verack`);
        this.internalEmitter.emit(`connected`);
      } else if (command === "inv") {
        const msg = Inv.read(payload);
        this.DEBUG_LOG &&
          console.log(
            `bsv-p2p: inv`,
            (Object.keys(msg) as (keyof typeof msg)[]) // Object.keys will always be of 'string' type, hence the hackery
              .filter((key) => msg[key].length > 0)
              .map((key) => `${key}: ${msg[key].length}`)
              .join(", ")
          );
        this.emit("inv", msg);
        const { blocks, txs } = msg;
        if (blocks.length > 0) {
          this.emit("block_hashes", { ticker, node, hashes: blocks });
        }
        if (this.listenerCount("transactions") > 0) {
          if (listenTxs && txs.length > 0) {
            if (typeof listenTxs === "function") {
              this.getTxs(await listenTxs(txs));
            } else {
              this.getTxs(txs);
            }
          }
          if (listenBlocks && blocks.length > 0) {
            this.getBlocks(blocks);
          }
        }
      } else if (command === "block") {
        if (!stream) {
          const block = Block.fromBuffer(payload);
          block.options = { validate };
          this.DEBUG_LOG &&
            console.log(`bsv-p2p: block`, block.getHash().toString("hex"));
          if (this.listenerCount("transactions") > 0) {
            await block.getTransactionsAsync((params: any) => {
              this.emit("transactions", { ...params, ticker, node });
            });
          }
          const hash = block.getHash().toString("hex");
          this.internalEmitter.emit(`block_${hash}`, block);
          this.emit("block", { block, ticker, node });
        }
      } else if (command === "tx") {
        const transaction = Transaction.fromBuffer(payload);
        this.DEBUG_LOG && console.log(`bsv-p2p: tx`, transaction);
        this.emit("transactions", {
          ticker,
          node,
          finished: true,
          transactions: [[0, transaction]],
        });
      } else if (command === "notfound") {
        const notfound = Inv.read(payload);
        this.DEBUG_LOG && console.log("bsv-p2p: notfound", notfound);
        this.emit(`notfound`, notfound);
        (Object.keys(notfound) as (keyof typeof notfound)[]).map((key) =>
          this.internalEmitter.emit(
            `notfound_${key}_${notfound[key].toString("hex")}`
          )
        );
      } else if (command === "alert") {
        this.DEBUG_LOG && console.log(`bsv-p2p: alert ${payload.toString()}`);
        this.emit(`alert`, { ticker, node, payload });
      } else if (command === "getdata") {
        const msg = GetData.read(payload);
        this.emit(`getdata`, msg);
        (Object.keys(msg) as (keyof typeof msg)[]).map((key) =>
          this.internalEmitter.emit(
            `getdata_${key}_${msg[key].toString("hex")}`
          )
        );
      } else if (command === "reject") {
        const msg = Reject.read(payload);
        this.DEBUG_LOG && console.log(`bsv-p2p: reject`, msg);
        this.emit(`reject`, msg);
        // this.internalEmitter.emit(`reject`, msg);
      } else if (command === "addr") {
        const addrs = Address.readAddr(payload);
        this.DEBUG_LOG && console.log(`bsv-p2p: addr`, addrs);
        this.emit("addr", { ticker, node, addr: addrs, addrs });
      } else if (command === "getheaders") {
        this.DEBUG_LOG && console.log(`bsv-p2p: getheaders`);
        this.emit(`getheaders`, { ticker, node });
      } else if (command === "sendcmpct") {
        this.DEBUG_LOG &&
          console.log(`bsv-p2p: sendcmpct ${payload.toString("hex")}`);
        this.emit(`sendcmpct`, { ticker, node, payload });
      } else if (command === "sendheaders") {
        this.DEBUG_LOG && console.log(`bsv-p2p: sendheaders`);
        this.emit(`sendheaders`, { ticker, node, payload });
      } else {
        this.DEBUG_LOG &&
          console.log(
            `bsv-p2p: Unknown command ${command}, ${payload.toString("hex")} ${
              payload.length
            } bytes`
          );
        this.emit(`unknown_msg`, { ticker, node, command, payload });
      }
      this.emit("message", { ticker, node, command, payload });

      if (remainingBuffer.length > 0) {
        return this.readMessage(remainingBuffer);
      }
    } catch (error) {
      this.DEBUG_LOG && console.log(`bsv-p2p: ERROR`, error);
      this.emit("error_message", { ticker, node, error });
      this.disconnect(this.autoReconnect); // TODO: Recover!
    }
  }

  connect(options = this.connectOptions) {
    if (!this.promiseConnect) {
      this.promiseConnect = new Promise<void>((resolve, reject) => {
        this.connectOptions = options;
        this.socket = new Net.Socket();
        const { socket, buffers, ticker, node } = this;
        const host = node.split(":")[0];
        const port = Number(node.split(":")[1]) || 8333;
        this.DEBUG_LOG && console.log(`bsv-p2p: Connecting to ${host}:${port}`);
        const timeout = setTimeout(
          () => reject(`timeout`),
          this.timeoutConnect
        );
        socket.on("connect", () => {
          this.DEBUG_LOG &&
            console.log(`bsv-p2p: Connected to ${host}:${port}`);
          const payload = Version.write({ ticker, options });
          this.sendMessage("version", payload, true);
          this.emit("connect", { ticker, node });
        });
        socket.on("error", (error: any) => {
          this.DEBUG_LOG && console.log(`bsv-p2p: Socket error`, error);
          this.emit("error_socket", { ticker, node, error });
          this.disconnect(this.autoReconnect);
          clearTimeout(timeout);
          reject(`disconnected`);
        });
        socket.on("end", () => {
          this.DEBUG_LOG && console.log(`bsv-p2p: Socket disconnected ${node}`);
          this.disconnect(this.autoReconnect);
          clearTimeout(timeout);
          reject(`disconnected`);
        });
        socket.on("data", (data) => {
          // this.DEBUG_LOG && console.log(`bsv-p2p: data`, data.toString('hex'))
          buffers.length += data.length;
          if (buffers.block) {
            this.streamBlock(data);
          } else {
            buffers.data.push(data);
          }

          if (buffers.length >= buffers.needed) {
            return this.readMessage(Buffer.concat(buffers.data));
          }
        });
        this.internalEmitter.once(`connected`, () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
          this.emit(`connected`, { ticker, node });
        });
        socket.connect(port, host);
      });
    }
    return this.promiseConnect;
  }
  disconnect(autoReconnect = false) {
    this.autoReconnect = !!autoReconnect;
    if (this.socket) {
      this.DEBUG_LOG && console.log(`bsv-p2p: Disconnected from ${this.node}`);
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.disconnects++;
      this.buffers = {
        data: [],
        needed: 0,
        length: 0,
        block: null,
        chunkNum: 0,
      };

      delete this.promiseGetHeaders;
      delete this.promiseConnect;

      this.internalEmitter.removeAllListeners();
      Object.keys(this.promises).map((key) =>
        this.promises[key].reject(`disconnected`)
      );
      this.promises = {};

      const { ticker, node, disconnects } = this;
      this.emit("disconnected", { ticker, node, disconnects });

      if (autoReconnect) {
        setTimeout(() => this.connect().catch(() => {}), 2000); // Wait 2 seconds before reconnecting
      }
    }
  }
  getHeaders({ from, to }: { from: string; to: string }) {
    if (!this.promiseGetHeaders) {
      this.promiseGetHeaders = new Promise((resolve, reject) => {
        try {
          const { ticker } = this;
          const payload = Headers.getheaders({ from, to, ticker });
          this.sendMessage("getheaders", payload);
          let timeout: NodeJS.Timeout;
          const onSuccess = (headers: any) => {
            clearTimeout(timeout);
            delete this.promiseGetHeaders;
            resolve(headers);
          };
          timeout = setTimeout(() => {
            delete this.promiseGetHeaders;
            this.internalEmitter.removeListener("headers", onSuccess);
            reject(Error(`timeout`));
          }, this.timeoutHeaders);
          this.internalEmitter.once("headers", onSuccess);
          this.promises.getHeaders = { reject };
        } catch (err) {
          delete this.promiseGetHeaders;
          reject(err);
        }
      });
    }
    return this.promiseGetHeaders;
  }
  getMempool() {
    this.sendMessage("mempool");
  }

  /**  Hex string or 32 byte Buffer. If stream = true transactions will come through on peer.on('transactions'... */
  getBlock(hash: string | Buffer) {
    return new Promise(async (resolve, reject) => {
      try {
        this.getBlocks([hash]);
        hash = hash.toString("hex");
        const onReject = () => reject(Error(`Not found`));
        this.internalEmitter.once(`notfound_block_${hash}`, onReject);
        this.internalEmitter.once(`block_${hash}`, (params) => {
          this.internalEmitter.removeListener(
            `notfound_block_${hash}`,
            onReject
          );
          resolve(params);
        });
        this.promises[hash] = { reject };
      } catch (err) {
        reject(err);
      }
    });
  }
  getBlocks(blocks: Array<string | Buffer>) {
    const payload = GetData.write(blocks, 2);
    this.sendMessage("getdata", payload);
  }
  broadcastTx(buf: Buffer) {
    return this.broadcastTxs([buf]);
  }
  broadcastTxs(txs: Buffer[]) {
    let hash: string;
    return new Promise<void>(async (resolve, reject) => {
      try {
        if (txs.length > MAX_PER_MSG)
          return reject(Error(`Too many transactions (${MAX_PER_MSG} max)`));

        const transactions = txs.map((buf) => Transaction.fromBuffer(buf));
        const payload = Inv.write({ transactions });
        for (const tx of transactions) {
          hash = tx.getHash().toString("hex");
          this.internalEmitter.once(`getdata_tx_${hash}`, () => {
            delete this.promises[hash];
            this.sendMessage("tx", tx.toBuffer());
            resolve();
          });
        }

        this.sendMessage("inv", payload);
        this.promises[hash] = { reject };
      } catch (err) {
        reject(err);
      }
    });
  }
  getTxs(txs: Array<Buffer | string>) {
    if (txs.length === 0) return;
    const payload = GetData.write(txs, 1);
    this.sendMessage("getdata", payload);
  }

  getAddr() {
    this.sendMessage("getaddr");
  }
  ping() {
    return new Promise((resolve, reject) => {
      try {
        const nonce = Crypto.randomBytes(8);
        const id = nonce.toString("hex");
        const date = +new Date();
        this.sendMessage("ping", nonce);
        this.promises[id] = { reject };
        this.internalEmitter.once(`pong_${id}`, () => {
          delete this.promises[id];
          resolve(+new Date() - date);
        });
      } catch (err) {
        reject(err);
      }
    });
  }
  listenForTxs(listenTxs = true) {
    this.listenTxs = listenTxs;
  }
  listenForBlocks() {
    this.listenBlocks = true;
  }
}
