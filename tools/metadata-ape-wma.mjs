// APE / WMA 时长解析自测（零依赖，node tools/metadata-ape-wma.mjs）
import assert from 'node:assert'

// 直接引用已编译产物（server/src 编译后落在 server/server/...）
const { parseApe, parseAsf } = await import('../server/server/library/metadata.js')

// ---------------- APE v3980 ----------------
// APE_DESCRIPTOR: 'MAC ' + version(3980) + descriptorBytes(32) 等；APE_HEADER 跟随
const blocksPerFrame = 73728 * 2 // v3980+ 默认
const finalFrameBlocks = 12345
const totalFrames = 100
const sampleRate = 44100

const d = Buffer.alloc(32)
d.write('MAC ', 0, 'latin1')
d.writeUInt16LE(3980, 4)
d.writeUInt32LE(32, 8) // descriptorBytes（不含自身头部26B，按字段语义=header 起始偏移-26）

const h = Buffer.alloc(26)
h.writeUInt16LE(0, 0) // compression level
h.writeUInt16LE(0, 2) // format flags
h.writeUInt32LE(blocksPerFrame, 4)
h.writeUInt32LE(finalFrameBlocks, 8)
h.writeUInt32LE(totalFrames, 12)
h.writeUInt16LE(2, 16) // channels
h.writeUInt32LE(sampleRate, 20)

const ape = Buffer.concat([d, h, Buffer.alloc(64)])
const t1 = parseApe(ape)
const expect1 = ((totalFrames - 1) * blocksPerFrame + finalFrameBlocks) / sampleRate
assert.ok(Math.abs(t1.durationSec - expect1) < 1e-6, 'APE duration mismatch: ' + t1.durationSec + ' vs ' + expect1)

// 非法输入：非 MAC 魔数
assert.deepEqual(parseApe(Buffer.from('NOPE')), {})
// 头部截断
assert.deepEqual(parseApe(ape.subarray(0, 40)), {})

// ---------------- ASF (WMA) ----------------
const guidFrom = (hex) => Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex')
// 真实磁盘字节序：GUID 混合端序存储，直接用与实现一致的常量字节
const HEADER_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])
const FILEPROP_GUID = Buffer.from([0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65])

// 真实存储序：标准 ASF GUID 在文件内按上述十六进制逐字节存储
const hd = Buffer.alloc(200)
HEADER_GUID.copy(hd, 0)
hd.writeBigUInt64LE(200n, 16) // header size
hd.writeUInt32LE(1, 24) // object count

const fp = Buffer.alloc(104)
FILEPROP_GUID.copy(fp, 0)
fp.writeBigUInt64LE(104n, 16)
fp.writeBigUInt64LE(0n, 24) // file id
fp.writeBigUInt64LE(0n, 32) // file size
fp.writeBigUInt64LE(0n, 40) // creation date
fp.writeBigUInt64LE(0n, 48) // data packets
// play duration @ body+40 = offset 64 in fp
const playDurMs = 245_500 // 4:05.5
fp.writeBigUInt64LE(BigInt(playDurMs) * 10000n, 64)
// send duration @72, preroll @80
fp.writeUInt32LE(3000, 80) // preroll ms
FILEPROP_GUID.copy(hd, 30, 0, 16)
fp.copy(hd, 30) // reuse: 先占位再修正——下面重写正确结构

// 重新构造：header object = 30B 头 + file properties object(104B)
const buf = Buffer.alloc(30 + 104)
HEADER_GUID.copy(buf, 0)
buf.writeBigUInt64LE(BigInt(buf.length), 16)
buf.writeUInt32LE(1, 24)
buf.writeUInt16LE(2, 28) // reserved
FILEPROP_GUID.copy(buf, 30)
fp.copy(buf, 30)

// 修正 fp 内部偏移：fp 对象体内 body 从 +24 开始，play duration 在 body+40 = fp+64 ✓（上面已按 fp+64 写）
const t2 = parseAsf(buf)
const expect2 = (playDurMs - 3000) / 1000 // 242.5
assert.ok(Math.abs(t2.durationSec - expect2) < 1e-6, 'ASF duration mismatch: ' + t2.durationSec + ' vs ' + expect2)

// 非 ASF
assert.deepEqual(parseAsf(Buffer.alloc(64)), {})
// GUID 正确但无 file properties
const buf2 = Buffer.alloc(30)
HEADER_GUID.copy(buf2, 0)
buf2.writeBigUInt64LE(30n, 16)
assert.deepEqual(parseAsf(buf2), {})

console.log('metadata-ape-wma: all passed')
console.log('  APE 100 frames @44.1kHz →', t1.durationSec.toFixed(2) + 's')
console.log('  WMA play 245.5s preroll 3s →', t2.durationSec.toFixed(2) + 's')
