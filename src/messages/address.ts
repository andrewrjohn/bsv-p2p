import { utils } from "bsv-minimal";

const { BufferReader, BufferWriter } = utils;

const IPV4_BUF = Buffer.from("00000000000000000000FFFF", "hex");

// TODO: `payload` should be Buffer or BufferReader
function read(
  payload: Buffer,
  { time, ipv4 }: { time?: boolean; ipv4?: boolean }
) {
  let br = payload as any;
  if (Buffer.isBuffer(br)) br = new BufferReader(br);
  const o: Record<any, any> = {};
  if (time) o.time = br.readUInt32LE();
  // o.services = br.readUInt64LEBN()
  o.services = br.readReverse(8);
  o.ip = br.read(16);
  o.port = br.readUInt16BE();
  if (ipv4 && Buffer.compare(IPV4_BUF, o.ip.slice(0, 12)) === 0) {
    const br2 = new BufferReader(o.ip.slice(12));
    o.ipv4 = `${br2.readUInt8()}.${br2.readUInt8()}.${br2.readUInt8()}.${br2.readUInt8()}`;
  }
  return o;
}

// TODO: `payload` should be Buffer or string or BufferReader
function readAddr(payload: Buffer | string) {
  const br = new BufferReader(payload);
  const count = br.readVarintNum();
  const addrs = [];
  for (let i = 0; i < count; i++) {
    const addr = read(br, { time: true, ipv4: true });
    addrs.push(addr);
  }
  return addrs;
}

interface WriteOptions {
  ip: string;
  port: number;
  services: any;
  time?: boolean;
  // TODO: This should be of type `BufferWriter`
  bw?: any;
}
function write({ time, services, ip, port, bw }: WriteOptions) {
  if (!bw) bw = new BufferWriter();
  if (time) bw.writeUInt32LE(time);
  // bw.writeUInt64LEBN(services)
  bw.writeReverse(services);
  bw.write(ip);
  bw.writeUInt16BE(port);
  return bw.toBuffer();
}

export default {
  read,
  readAddr,
  write,
};
