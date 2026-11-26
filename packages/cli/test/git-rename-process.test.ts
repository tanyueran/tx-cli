import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_BIN = fileURLToPath(new URL("../bin/tx-cli", import.meta.url));

let tempRoot: string;
let repoRoot: string;
let home: string;
let configHome: string;

/**
 * 创建隔离用户目录和 Git 配置的子进程环境
 * @param {string} homeDirectory - 子进程使用的用户主目录
 * @param {string} configDirectory - 子进程使用的 XDG 配置目录
 * @returns {NodeJS.ProcessEnv} 隔离后的子进程环境变量
 */
function createIsolatedEnvironment(
  homeDirectory: string,
  configDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

/**
 * 在临时仓库中执行真实 Git 命令
 * @param {string[]} args - 传给 Git 的命令行参数
 * @returns {SpawnSyncReturns<string>} 包含退出码、标准输出与标准错误的进程结果
 */
function runGit(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: createIsolatedEnvironment(home, configHome),
    input: "",
    timeout: 15_000,
  });
}

/**
 * 在临时仓库中执行真实构建的 CLI
 * @param {string[]} args - 传给 CLI 的命令行参数
 * @returns {SpawnSyncReturns<string>} 包含退出码、标准输出与标准错误的进程结果
 */
function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: createIsolatedEnvironment(home, configHome),
    input: "",
    timeout: 15_000,
  });
}

/**
 * 在临时仓库中写入并提交一个文件
 * @param {string} relativePath - 相对仓库根目录的文件路径
 * @param {string} content - 要写入的文件内容
 * @param {string} message - Git 提交信息
 * @returns {void}
 */
function commitFixture(
  relativePath: string,
  content: string,
  message: string,
): void {
  writeFileSync(join(repoRoot, relativePath), content);
  const addResult = runGit(["add", relativePath]);
  expect(addResult.status, addResult.stderr).toBe(0);
  const commitResult = runGit(["commit", "-m", message]);
  expect(commitResult.status, commitResult.stderr).toBe(0);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tx-cli-git-rename-process-"));
  repoRoot = join(tempRoot, "repository");
  home = join(tempRoot, "home");
  configHome = join(tempRoot, "xdg-config");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const initResult = runGit(["init"]);
  expect(initResult.status, initResult.stderr).toBe(0);

  const localConfig = {
    "user.name": "Tx CLI Test",
    "user.email": "tx-cli@example.com",
    "core.hooksPath": "/dev/null",
    "commit.gpgsign": "false",
  };
  for (const [key, value] of Object.entries(localConfig)) {
    const configResult = runGit(["config", key, value]);
    expect(configResult.status, configResult.stderr).toBe(0);
  }
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("真实构建产物的 git-rename 进程行为", () => {
  it("重命名已跟踪文件后正常退出，新文件被跟踪且旧文件不存在", () => {
    commitFixture("old.ts", "export const value = 1;\n", "提交旧文件");

    const result = runCli(["git-rename", "old.ts", "new.ts"]);

    expect(
      result.status,
      `标准输出：\n${result.stdout}\n标准错误：\n${result.stderr}`,
    ).toBe(0);
    const trackedResult = runGit(["ls-files", "--error-unmatch", "new.ts"]);
    expect(trackedResult.status, trackedResult.stderr).toBe(0);
    expect(existsSync(join(repoRoot, "old.ts"))).toBe(false);
  }, 30_000);

  it("第二次 mv 失败时退出 1，并回滚到干净的初始状态", () => {
    const originalContent = "export const value = 1;\n";
    commitFixture("old.ts", originalContent, "提交旧文件");
    commitFixture("blocker", "普通文件会阻止创建同名目录\n", "提交阻塞文件");

    const result = runCli(["git-rename", "old.ts", "blocker/new.ts"]);

    expect(
      result.status,
      `标准输出：\n${result.stdout}\n标准错误：\n${result.stderr}`,
    ).toBe(1);
    expect(result.stdout).toContain("已回滚到原文件名");
    expect(result.stderr).toContain("重命名失败");
    expect(readFileSync(join(repoRoot, "old.ts"), "utf8")).toBe(
      originalContent,
    );
    expect(runGit(["status", "--porcelain"]).stdout).toBe("");
    expect(existsSync(join(repoRoot, "___old.ts"))).toBe(false);
    expect(existsSync(join(repoRoot, "blocker", "new.ts"))).toBe(false);
  }, 30_000);
});
