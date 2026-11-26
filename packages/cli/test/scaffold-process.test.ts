import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_BIN = fileURLToPath(new URL("../bin/tx-cli", import.meta.url));

let tempRoot: string;
let workingDir: string;

/**
 * 使用当前 Node 执行真实构建的 CLI，并隔离 HOME 与工作目录
 * @param {string[]} args - 传给 CLI 的命令行参数
 * @returns {SpawnSyncReturns<string>} 包含退出码、标准输出与标准错误的进程结果
 */
function runCli(args: string[]): SpawnSyncReturns<string> {
  const home = join(tempRoot, "home");
  mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: workingDir,
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

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tx-cli-scaffold-process-"));
  workingDir = join(tempRoot, "workspace");
  mkdirSync(workingDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("真实构建产物的脚手架命令", () => {
  it("create demo-app 在空目录生成项目并渲染关键模板文件", () => {
    const result = runCli(["create", "demo-app"]);

    expect(
      result.status,
      `create 执行失败：${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("创建成功");

    const projectDir = join(workingDir, "demo-app");
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf8"),
    ) as { name: string };
    expect(packageJson.name).toBe("demo-app");

    for (const relativePath of [
      "index.html",
      "vite.config.ts",
      "src/main.ts",
      "src/App.vue",
      "src/router/index.ts",
      ".gitignore",
    ]) {
      expect(
        existsSync(join(projectDir, relativePath)),
        `应生成项目关键文件：${relativePath}`,
      ).toBe(true);
    }
    expect(existsSync(join(projectDir, "package.json.hbs"))).toBe(false);
    expect(existsSync(join(projectDir, "template.json"))).toBe(false);
  });

  it("add user-profile 生成模块文件并转换组件名", () => {
    const result = runCli(["add", "user-profile"]);

    expect(
      result.status,
      `add 执行失败：${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("模块已生成");

    const moduleDir = join(workingDir, "user-profile");
    const componentPath = join(moduleDir, "index.vue");
    const stylePath = join(moduleDir, "index.module.scss");
    expect(existsSync(componentPath), "应生成模块入口 index.vue").toBe(true);
    expect(existsSync(stylePath), "应生成模块样式 index.module.scss").toBe(
      true,
    );

    const component = readFileSync(componentPath, "utf8");
    expect(component).toContain('name: "UserProfile"');
    expect(component).toContain("user-profile-wrapper");
    expect(component).toContain('import style from "./index.module.scss"');
    expect(readFileSync(stylePath, "utf8")).toContain(
      ".user-profile-wrapper",
    );
    expect(existsSync(join(moduleDir, "template.json"))).toBe(false);
  });
});
