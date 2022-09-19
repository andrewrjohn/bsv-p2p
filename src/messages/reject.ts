import { utils } from "bsv-minimal";

const { BufferReader } = utils;

function read(payload: Buffer | string) {
  const br = new BufferReader(payload);
  const o: Record<any, any> = {};
  o.message = br.readVarintNum().toString();
  o.ccode = br.readUInt8();
  o.reason = br.readVarintNum().toString();
  if (!br.eof()) {
    o.data = br.readReverse(32);
  }

  return o;
}

module.exports = {
  read,
};
