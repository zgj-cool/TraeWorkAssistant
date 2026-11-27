// 让 Tauri 的 MSI 打包结果在构建期间直接写入仓库根目录 release/。
//
// Tauri 2 没有暴露 bundle 输出目录配置，固定写到
// <CARGO_TARGET_DIR>/release/bundle/msi/。这里在打包前把该生成目录改成
// 指向根目录 release/ 的 junction（仅 Windows），构建成功后再解除。
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
  const cleanup = process.argv.includes('--cleanup');

  const removeBundleEntry = (kind) => {
    const linkPath = path.join(bundleDir, kind);
    let stat;
    try {
      stat = fs.lstatSync(linkPath);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    // junction 在 Node 中表现为 symbolic link，只解除链接；真实目录是 target 下的旧产物，可清理。
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      console.log(`[release-output] 已解除 ${linkPath}`);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      console.log(`[release-output] 已清理旧产物目录 ${linkPath}`);
    }
    return true;
  };

  try {
    if (cleanup) {
      for (const kind of ['msi', 'nsis']) removeBundleEntry(kind);
      try {
        fs.rmdirSync(bundleDir);
      } catch (err) {
        // msi/nsis 已处理；其它未知目录非空时保留，避免误删。
        if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
      }
      console.log('[release-output] 构建期 bundle junction 已清理，产物保留在 release/');
    } else {
      fs.mkdirSync(releaseDir, { recursive: true });
      fs.mkdirSync(bundleDir, { recursive: true });

      // 默认只构建 MSI；解除遗留 NSIS junction，避免它继续把 release/ 映射进 target。
      removeBundleEntry('nsis');

      const kind = 'msi';
      const linkPath = path.join(bundleDir, kind);
      let stat;
      try {
        stat = fs.lstatSync(linkPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
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
    }
  } catch (err) {
    console.error(
      `[release-output] 无法维护 ${bundleDir} 与 ${releaseDir} 的输出映射。\n` +
        '请先退出正在运行的「AI Work 助手」（它可能占用了旧 bundle 目录），然后重新执行打包。\n' +
        `原始错误：${err}`,
    );
    process.exit(1);
  }
}
