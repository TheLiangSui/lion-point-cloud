// 把 .ply 点云转成前端可直接读的紧凑数据（base64 编码的 Float32Array 坐标）
// 运行： node ply2points.mjs
// 输出： lion_points.js  →  window.LION_POINTS = { count, b64 }

import fs from 'node:fs';
import path from 'node:path';

const SRC = 'G:/Users/u1521/Desktop/出版物设计/点云模型/lion_pointcloud.ply';
const OUT = path.join(import.meta.dirname, 'lion_points.js');

const MAX_POINTS = 57682; // 上限，对齐参考站点的粒子数
const FIT_SIZE = 400;     // 归一化后模型最长边（参考站点 logo 采样同样是 400）

// ── 类型表 ──────────────────────────────────────────────
const TYPE_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

const buf = fs.readFileSync(SRC);

// ── 解析 header ─────────────────────────────────────────
const headerEndIdx = buf.indexOf('end_header');
if (headerEndIdx < 0) throw new Error('不是合法的 PLY：找不到 end_header');
const headerText = buf.subarray(0, headerEndIdx).toString('utf8');
const headerLines = headerText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

let format = null;
let vertexCount = 0;
let props = [];
let currentElement = null;

for (const line of headerLines) {
  const parts = line.split(/\s+/);
  if (parts[0] === 'format') {
    format = parts[1];
  } else if (parts[0] === 'element') {
    currentElement = parts[1];
    if (currentElement === 'vertex') vertexCount = parseInt(parts[2], 10);
  } else if (parts[0] === 'property' && currentElement === 'vertex') {
    if (parts[1] === 'list') {
      props.push({ name: parts[4], type: 'list', size: 0, offset: 0 });
    } else {
      props.push({ name: parts[2], type: parts[1], size: TYPE_SIZE[parts[1]] });
    }
  }
}

if (!format) throw new Error('header 里没有 format 行');
if (!vertexCount) throw new Error('header 里没有 element vertex');

// 累计偏移与 stride
let stride = 0;
for (const p of props) {
  if (p.type === 'list') throw new Error('vertex 元素含 list 属性，未支持');
  p.offset = stride;
  stride += p.size;
}

console.log('文件大小   :', (buf.length / 1024).toFixed(1), 'KB');
console.log('格式       :', format);
console.log('顶点数     :', vertexCount.toLocaleString());
console.log('每顶点字节 :', stride);
console.log('属性       :', props.map(p => `${p.name}:${p.type}`).join(', '));

// ── 数据起点：跳过 end_header 那一行 ──────────────────────
let dataStart = buf.indexOf('\n', headerEndIdx) + 1;

// ── 读取顶点坐标 ─────────────────────────────────────────
const xyz = new Float32Array(vertexCount * 3);
const hasColor = ['red', 'green', 'blue'].every(n => props.some(p => p.name === n));

if (format === 'binary_little_endian' || format === 'binary_big_endian') {
  const le = format === 'binary_little_endian';
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const reader = {
    1: (o) => view.getUint8(o),
    2: (o) => view.getUint16(o, le),
    4: (o) => view.getFloat32(o, le),
    8: (o) => view.getFloat64(o, le),
  };
  const idxOf = (name) => props.findIndex(p => p.name === name);
  const ix = idxOf('x'), iy = idxOf('y'), iz = idxOf('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('缺少 x/y/z 属性');
  const read3 = (i, pi) => {
    const p = props[pi];
    const o = dataStart + i * stride + p.offset;
    const v = p.type === 'float' || p.type === 'float32' || p.type === 'double' || p.type === 'float64'
      ? reader[p.size](o)
      : p.type === 'uchar' || p.type === 'uint8' || p.type === 'char' || p.type === 'int8'
        ? view.getUint8(o)
        : p.size === 2 ? view.getInt16(o, le) : view.getInt32(o, le);
    return v;
  };
  for (let i = 0; i < vertexCount; i++) {
    xyz[i * 3] = read3(i, ix);
    xyz[i * 3 + 1] = read3(i, iy);
    xyz[i * 3 + 2] = read3(i, iz);
  }
} else if (format === 'ascii') {
  const body = buf.subarray(dataStart).toString('utf8').trim().split(/\r?\n/);
  const ix = props.findIndex(p => p.name === 'x');
  const iy = props.findIndex(p => p.name === 'y');
  const iz = props.findIndex(p => p.name === 'z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('缺少 x/y/z 属性');
  const n = Math.min(vertexCount, body.length);
  for (let i = 0; i < n; i++) {
    const t = body[i].trim().split(/\s+/);
    xyz[i * 3] = parseFloat(t[ix]);
    xyz[i * 3 + 1] = parseFloat(t[iy]);
    xyz[i * 3 + 2] = parseFloat(t[iz]);
  }
} else {
  throw new Error('未知 format: ' + format);
}

console.log('含顶点颜色 :', hasColor ? '是（本次只用坐标，渲染成白色粒子）' : '否');

// ── 包围盒 ───────────────────────────────────────────────
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < xyz.length; i += 3) {
  if (xyz[i] < minX) minX = xyz[i]; if (xyz[i] > maxX) maxX = xyz[i];
  if (xyz[i + 1] < minY) minY = xyz[i + 1]; if (xyz[i + 1] > maxY) maxY = xyz[i + 1];
  if (xyz[i + 2] < minZ) minZ = xyz[i + 2]; if (xyz[i + 2] > maxZ) maxZ = xyz[i + 2];
}
const sizeX = maxX - minX, sizeY = maxY - minY, sizeZ = maxZ - minZ;
console.log('原始包围盒 :', [sizeX, sizeY, sizeZ].map(v => v.toFixed(1)).join(' × '));

// ── 抽稀（仅在超过上限时） ────────────────────────────────
let pts = xyz;
let count = vertexCount;
if (vertexCount > MAX_POINTS) {
  const keep = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) keep[i] = i;
  for (let i = 0; i < MAX_POINTS; i++) { // 部分洗牌，均匀随机抽稀
    const j = i + Math.floor(Math.random() * (vertexCount - i));
    const t = keep[i]; keep[i] = keep[j]; keep[j] = t;
  }
  pts = new Float32Array(MAX_POINTS * 3);
  for (let i = 0; i < MAX_POINTS; i++) {
    const s = keep[i] * 3;
    pts[i * 3] = xyz[s]; pts[i * 3 + 1] = xyz[s + 1]; pts[i * 3 + 2] = xyz[s + 2];
  }
  count = MAX_POINTS;
  console.log(`抽稀       : ${vertexCount.toLocaleString()} → ${count.toLocaleString()}`);
} else {
  console.log('抽稀       : 不需要（点数未超过上限）');
}

// ── 归一化：居中 + 缩放到 FIT_SIZE ────────────────────────
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
const maxDim = Math.max(sizeX, sizeY, sizeZ) || 1;
const s = FIT_SIZE / maxDim;
for (let i = 0; i < pts.length; i += 3) {
  pts[i] = (pts[i] - cx) * s;
  pts[i + 1] = (pts[i + 1] - cy) * s;
  pts[i + 2] = (pts[i + 2] - cz) * s;
}
const outPts = pts.slice(0, count * 3);
console.log('归一化     : 缩放系数', s.toFixed(4), '→ 最长边', FIT_SIZE);

// ── 输出为经典 script（base64），file:// 直接打开也能用 ────
const b64 = Buffer.from(outPts.buffer, outPts.byteOffset, outPts.byteLength).toString('base64');
const js = `// 由 ply2points.mjs 自动生成，请勿手改\n// 源文件：lion_pointcloud.ply　点数：${count}\nwindow.LION_POINTS = { count: ${count}, b64: "${b64}" };\n`;
fs.writeFileSync(OUT, js, 'utf8');
console.log('输出       :', OUT, `(${(js.length / 1024 / 1024).toFixed(2)} MB)`);