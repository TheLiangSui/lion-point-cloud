// 把 .ply 点云转成前端可直接读的紧凑数据（base64 编码的 Float32Array 坐标）
// 运行： node ply2points.mjs            → 处理下方 MODELS 里的全部模型
//        node ply2points.mjs lion       → 只处理指定模型
// 输出： <key>_points.js  →  window.<KEY>_POINTS = { count, b64 }
//
// 说明：页面里所有模型共用同一套 geometry，因此这里会把所有模型统一到相同点数
//      （取各模型顶点数的最大值）：多的随机抽稀，少的随机重复采样并加轻微抖动。

import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'G:/Users/u1521/Desktop/出版物设计/点云模型';
const OUT_DIR = import.meta.dirname;

// key（= 输出文件名前缀 / 页面里的 window 变量名）→ 源 .ply 文件
// 顺序与 index.html 的 MODEL_LIST 保持一致（仅影响控制台输出顺序，不影响产物）
const MODELS = [
  { key: 'paifang',  ply: 'paifang_pointcloud.ply' },
  { key: 'lion',     ply: 'lion_pointcloud.ply' },
  { key: 'papercut', ply: 'papercut_pointcloud.ply' },
];

const MAX_POINTS = 57682; // 上限，对齐参考站点的粒子数
const FIT_SIZE = 400;     // 归一化后模型最长边（参考站点 logo 采样同样是 400）

// ── 类型表 ──────────────────────────────────────────────
const TYPE_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

// ── 解析单个 PLY，返回原始顶点坐标 ────────────────────────
function parsePly(srcPath) {
  const buf = fs.readFileSync(srcPath);

  const headerEndIdx = buf.indexOf('end_header');
  if (headerEndIdx < 0) throw new Error('不是合法的 PLY：找不到 end_header');
  const headerText = buf.subarray(0, headerEndIdx).toString('utf8');
  const headerLines = headerText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  let format = null;
  let vertexCount = 0;
  const props = [];
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

  const dataStart = buf.indexOf('\n', headerEndIdx) + 1;
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
    const readAxis = (i, pi) => {
      const p = props[pi];
      const o = dataStart + i * stride + p.offset;
      return p.type === 'float' || p.type === 'float32' || p.type === 'double' || p.type === 'float64'
        ? reader[p.size](o)
        : p.type === 'uchar' || p.type === 'uint8' || p.type === 'char' || p.type === 'int8'
          ? view.getUint8(o)
          : p.size === 2 ? view.getInt16(o, le) : view.getInt32(o, le);
    };
    for (let i = 0; i < vertexCount; i++) {
      xyz[i * 3] = readAxis(i, ix);
      xyz[i * 3 + 1] = readAxis(i, iy);
      xyz[i * 3 + 2] = readAxis(i, iz);
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
  return { xyz, count: vertexCount };
}

// ── 居中 + 缩放到 FIT_SIZE ────────────────────────────────
function normalize(xyz) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < xyz.length; i += 3) {
    if (xyz[i] < minX) minX = xyz[i]; if (xyz[i] > maxX) maxX = xyz[i];
    if (xyz[i + 1] < minY) minY = xyz[i + 1]; if (xyz[i + 1] > maxY) maxY = xyz[i + 1];
    if (xyz[i + 2] < minZ) minZ = xyz[i + 2]; if (xyz[i + 2] > maxZ) maxZ = xyz[i + 2];
  }
  const sizeX = maxX - minX, sizeY = maxY - minY, sizeZ = maxZ - minZ;
  console.log('原始包围盒 :', [sizeX, sizeY, sizeZ].map(v => v.toFixed(1)).join(' × '));

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const maxDim = Math.max(sizeX, sizeY, sizeZ) || 1;
  const s = FIT_SIZE / maxDim;
  for (let i = 0; i < xyz.length; i += 3) {
    xyz[i] = (xyz[i] - cx) * s;
    xyz[i + 1] = (xyz[i + 1] - cy) * s;
    xyz[i + 2] = (xyz[i + 2] - cz) * s;
  }
  console.log('归一化     : 缩放系数', s.toFixed(4), '→ 最长边', FIT_SIZE);
}

// ── 重采样到 targetCount（多则抽稀，少则重复采样 + 轻微抖动）──
function resample(xyz, count, targetCount) {
  if (count === targetCount) {
    console.log('重采样     : 不需要');
    return xyz.slice();
  }

  const out = new Float32Array(targetCount * 3);
  if (count > targetCount) {
    // 部分洗牌，均匀随机抽稀
    const keep = new Uint32Array(count);
    for (let i = 0; i < count; i++) keep[i] = i;
    for (let i = 0; i < targetCount; i++) {
      const j = i + Math.floor(Math.random() * (count - i));
      const t = keep[i]; keep[i] = keep[j]; keep[j] = t;
    }
    for (let i = 0; i < targetCount; i++) {
      const s = keep[i] * 3;
      out[i * 3] = xyz[s]; out[i * 3 + 1] = xyz[s + 1]; out[i * 3 + 2] = xyz[s + 2];
    }
    console.log(`重采样     : 抽稀 ${count.toLocaleString()} → ${targetCount.toLocaleString()}`);
  } else {
    // 先原样拷贝，剩余随机重复已有点并加抖动（避免完全重叠导致加性混合过亮）
    out.set(xyz.subarray(0, count * 3));
    const jitter = FIT_SIZE * 0.0015;
    for (let i = count; i < targetCount; i++) {
      const s = Math.floor(Math.random() * count) * 3;
      out[i * 3]     = xyz[s]     + (Math.random() - 0.5) * jitter;
      out[i * 3 + 1] = xyz[s + 1] + (Math.random() - 0.5) * jitter;
      out[i * 3 + 2] = xyz[s + 2] + (Math.random() - 0.5) * jitter;
    }
    console.log(`重采样     : 上采样 ${count.toLocaleString()} → ${targetCount.toLocaleString()}（重复点带 ${jitter.toFixed(2)} 抖动）`);
  }
  return out;
}

function writeOut(key, plyName, pts, count) {
  const OUT = path.join(OUT_DIR, `${key}_points.js`);
  const b64 = Buffer.from(pts.buffer, pts.byteOffset, pts.byteLength).toString('base64');
  const varName = key.toUpperCase() + '_POINTS';
  const js = `// 由 ply2points.mjs 自动生成，请勿手改\n// 源文件：${plyName}　点数：${count}\nwindow.${varName} = { count: ${count}, b64: "${b64}" };\n`;
  fs.writeFileSync(OUT, js, 'utf8');
  console.log('输出       :', OUT, `(${(js.length / 1024 / 1024).toFixed(2)} MB)`);
}

// ── 主流程：全部读入 → 统一点数 → 输出 ────────────────────
const picked = process.argv.slice(2);
const list = picked.length ? MODELS.filter(m => picked.includes(m.key)) : MODELS;
if (!list.length) throw new Error('没有匹配的模型，可选：' + MODELS.map(m => m.key).join(', '));

const parsed = list.map(m => {
  console.log(`\n──── ${m.key} ← ${m.ply} ────`);
  const { xyz, count } = parsePly(path.join(SRC_DIR, m.ply));
  normalize(xyz);
  return { ...m, xyz, count };
});

const targetCount = Math.min(MAX_POINTS, Math.max(...parsed.map(p => p.count)));
console.log(`\n统一点数   : ${targetCount.toLocaleString()}（各模型顶点数最大值，未超上限 ${MAX_POINTS.toLocaleString()}）`);

for (const p of parsed) {
  console.log(`\n──── 输出 ${p.key} ────`);
  const pts = resample(p.xyz, p.count, targetCount);
  writeOut(p.key, p.ply, pts, targetCount);
}

console.log('\n全部完成。');