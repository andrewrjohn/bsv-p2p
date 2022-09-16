import { utils } from "bsv-minimal";

const { BufferReader, BufferWriter } = utils;

function read(buffer: Buffer) {
  const br = new BufferReader(buffer);
  const count = br.readVarintNum();
  const errors: Buffer[] = [];
  const txs: Buffer[] = [];
  const blocks: Buffer[] = [];
  const filtered_block: Buffer[] = [];
  const compact_block: Buffer[] = [];
  const other = [];
  for (let i = 0; i < count; i++) {
    let type = br.readUInt32LE();
    const hash = br.readReverse(32);
    if (type === 0) {
      errors.push(hash);
    } else if (type === 1) {
      txs.push(hash);
    } else if (type === 2) {
      blocks.push(hash);
    } else if (type === 3) {
      filtered_block.push(hash);
    } else if (type === 4) {
      compact_block.push(hash);
    } else {
      other.push({
        type,
        hash,
      });
    }
  }
  if (!br.eof()) throw new Error(`Invalid payload`);
  return { txs, blocks, errors, filtered_block, compact_block, other };
}

function write({ transactions }: { transactions: any[] }) {
  const bw = new BufferWriter();
  bw.writeVarintNum(transactions.length);
  for (const transaction of transactions) {
    bw.writeUInt32LE(1);
    bw.writeReverse(transaction.getHash());
  }
  return bw.toBuffer();
}

export { read, write };
