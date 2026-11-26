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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_BIN = fileURLToPath(new URL("../bin/tx-cli", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const CLI_VERSION = (
  JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }
).version;

let tempRoot: string;

/**
 * 使用当前 Node 执行真实构建的 CLI，并隔离 HOME 与工作目录
 * @param {string[]} args - 传给 CLI 的命令行参数
 * @returns {SpawnSyncReturns<string>} 包含退出码、标准输出与标准错误的进程结果
 */
function runCli(args: string[]): SpawnSyncReturns<string> {
  const home = join(tempRoot, "home");
  mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    input: "",
    timeout: 15_000,
  });
}

/**
 * 在当前测试的临时目录中写入文件，并自动创建父目录
 * @param {string} relativePath - 相对临时根目录的文件路径
 * @param {string} content - 要写入的文本内容
 * @returns {string} 写入文件的绝对路径
 */
function writeFixture(relativePath: string, content: string): string {
  const filePath = join(tempRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tx-cli-process-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("真实构建产物的 CLI 进程行为", () => {
  it("--help 正常退出并列出主要命令", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: tx-cli");
    for (const command of [
      "create",
      "add",
      "copy",
      "server",
      "git-rename",
      "commit-fix",
      "chat",
      "agent",
    ]) {
      expect(result.stdout).toMatch(
        new RegExp(`^\\s+${command}(?:\\s|$)`, "m"),
      );
    }
  });

  it("--version 正常退出并输出包版本", () => {
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(CLI_VERSION);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("未知命令退出 1，标准错误可读且不包含堆栈", () => {
    const result = runCli(["not-a-real-command"]);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("not-a-real-command");
    expect(result.stderr).not.toMatch(/^\s*at\s+/m);
    expect(result.stderr).not.toContain("node:internal");
  });

  it("copy 缺少位置参数时退出 1", () => {
    const result = runCli(["copy"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required argument");
    expect(result.stderr).toContain("src");
  });

  it("agent 收到非法 --sandbox 时退出 1，且不进入配置引导", () => {
    const result = runCli(["agent", "--sandbox", "not-a-sandbox"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--sandbox");
    expect(result.stderr).toContain("not-a-sandbox");
    expect(output).not.toContain("首次使用需要配置大模型服务");
    expect(output).not.toContain("API Key");
    expect(existsSync(join(tempRoot, ".tx-cli", "config.json"))).toBe(false);
    expect(existsSync(join(tempRoot, "home", ".tx-cli", "config.json"))).toBe(
      false,
    );
  });

  it("chat 收到非法 --think 时退出 1，且不进入配置引导", () => {
    const result = runCli(["chat", "--think", "extreme"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("无法识别的思考档位");
    expect(result.stderr).toContain("extreme");
    expect(output).not.toContain("首次使用需要配置大模型服务");
    expect(output).not.toContain("API Key");
    expect(existsSync(join(tempRoot, ".tx-cli", "config.json"))).toBe(false);
    expect(existsSync(join(tempRoot, "home", ".tx-cli", "config.json"))).toBe(
      false,
    );
  });

  it("copy --force 真实复制目录，重复 --filter 均生效且输出统计准确", () => {
    const source = join(tempRoot, "source");
    const destination = join(tempRoot, "destination");
    const target = join(destination, "source");
    writeFixture("source/keep.txt", "新内容");
    writeFixture("source/drop.log", "应排除");
    writeFixture("source/nested/keep.md", "保留嵌套文件");
    writeFixture("source/nested/drop.tmp", "也应排除");
    writeFixture("destination/source/keep.txt", "旧内容");

    const result = runCli([
      "copy",
      source,
      destination,
      "--force",
      "--filter",
      "**/*.log",
      "--filter",
      "**/*.tmp",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`复制完成：${source} -> ${target}`);
    expect(result.stdout).toContain("复制 2 个文件，跳过 2 项");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("新内容");
    expect(readFileSync(join(target, "nested/keep.md"), "utf8")).toBe(
      "保留嵌套文件",
    );
    expect(existsSync(join(target, "drop.log"))).toBe(false);
    expect(existsSync(join(target, "nested/drop.tmp"))).toBe(false);
  });
});
