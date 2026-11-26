import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * 在所有测试工作进程启动前构建一次真实 CLI，避免并行测试重复清空和写入同一产物目录
 * @returns {void} 构建成功时返回；失败时抛出包含构建日志的错误
 */
export default function buildCliForTests(): void {
  const result = spawnSync("pnpm", ["--filter", "@tx-cli/cli", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 180_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `CLI 测试产物构建失败：${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
}
