// 让 Tauri 的 MSI / NSIS 打包结果直接写入仓库根目录 release/。
//
// Tauri 2 没有暴露 bundle 输出目录配置，固定写到
// <CARGO_TARGET_DIR>/release/bundle/<msi|nsis>/。这里在打包前把这两个
// 生成目录改成指向根目录 release/ 的 junction（仅 Windows），安装器会由
// Tauri 直接落盘到 release/，不需要打包后再复制。
//
// 只清理 target 下的旧 bundle 生成目录，不触碰 release/ 内已有产物。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  console.log('[release-output] 非 Windows 平台，保持 Tauri 默认 bundle 输出目录');
} else {
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(root, 'src-tauri', process.env.CARGO_TARGET_DIR)
    : path.join(root, 'src-tauri', 'target');
  const bundleDir = path.join(cargoTargetDir, 'release', 'bundle');
  const releaseDir = path.join(root, 'release');

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  for (const kind of ['msi', 'nsis']) {
    const linkPath = path.join(bundleDir, kind);
    try {
      let stat;
      try {
        stat = fs.lstatSync(linkPath);
      } catch {
        // 路径不存在，直接创建 junction
      }

      let backupPath;
      if (stat) {
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
        } else {
          // 旧版 Tauri 产物目录可能被杀毒/索引进程短暂占用，先改名再建 junction；
          // 备份只位于 target 生成目录，成功后尽力清理，不触碰 release/。
          backupPath = `${linkPath}.bak-${Date.now()}`;
          fs.renameSync(linkPath, backupPath);
        }
      }

      fs.symlinkSync(releaseDir, linkPath, 'junction');
      console.log(`[release-output] ${linkPath} -> ${releaseDir}`);

      if (backupPath) {
        try {
          fs.rmSync(backupPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        } catch (err) {
          console.warn(`[release-output] 旧 bundle 目录暂无法清理，已保留：${backupPath} (${err})`);
        }
      }
    } catch (err) {
      console.error(
        `[release-output] 无法将 ${linkPath} 指向 ${releaseDir}。\n` +
          '请先退出正在运行的「AI Work 助手」（它可能占用了旧 bundle 目录），然后重新执行打包。\n' +
          `原始错误：${err}`,
      );
      process.exit(1);
    }
  }
}
