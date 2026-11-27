#!/usr/bin/env node
/** MSI 打包产物归位 / 校验输出：
 * `npm run tauri build` 默认只构建 MSI，并在打包期间临时直出到 release/；
 * 本脚本仍兼容旧版「产物在 target/release/bundle/」的布局（缺失时才复制）。
 * 应用内更新功能已移除，不再生成 latest.json。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TAURI = resolve(ROOT, 'src-tauri');

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

function readVersion(conf) {
  // 版本单源 = Cargo.toml；tauri.conf.json 里的 version 字段已移除（自动回读 Cargo.toml）
  if (conf.version) return conf.version;
  const m = readFileSync(resolve(SRC_TAURI, 'Cargo.toml'), 'utf8').match(
    /^version\s*=\s*"(\d+\.\d+\.\d+)"/m,
  );
  if (!m) die('ERROR: 无法从 Cargo.toml 读取版本号');
  return m[1];
}

const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
const version = readVersion(conf);
const product = conf.productName;
const outDir = resolve(ROOT, 'release');
mkdirSync(outDir, { recursive: true });

const jobs = [
  [
    resolve(SRC_TAURI, 'target/release/bundle/msi', `${product}_${version}_x64_zh-CN.msi`),
    resolve(outDir, `${product}_${version}_x64_zh-CN.msi`),
  ],
];

for (const [src, dst] of jobs) {
  const srcExists = existsSync(src);
  const dstExists = existsSync(dst);
  // 正常构建结束后 junction 已解除，src 不存在但 dst 已有产物；旧布局则从 src 复制。
  const alreadyThere =
    dstExists && (!srcExists || realpathSync(src) === realpathSync(dst));
  if (alreadyThere) {
    console.log('OK（产物已在 release）:', dst);
  } else if (srcExists) {
    copyFileSync(src, dst);
    console.log('OK:', dst);
  } else {
    die(`未找到 MSI 产物：${src}`);
  }
}

const msiName = `${product}_${version}_x64_zh-CN.msi`;
const msiPath = resolve(outDir, msiName);
const h = createHash('sha256').update(readFileSync(msiPath)).digest('hex');
console.log(`SHA256 ${h}  ${msiName}`);
