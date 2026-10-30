import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantGlobalTrust,
  resolveUntrustedFallback,
} from "../src/core/sandbox/bootstrap/trust";
import type { UntrustedFallbackInput } from "../src/core/sandbox/bootstrap/trust";

/** 测试用临时目录 */
let dir: string;

/**
 * 构造未信任降级决策的输入（默认：文件来源 full 档 + never 策略，非信任目录）
 * @param {Partial<UntrustedFallbackInput>} overrides - 覆盖字段
 * @returns {UntrustedFallbackInput} 决策输入
 */
function makeInput(
  overrides: Partial<UntrustedFallbackInput> = {},
): UntrustedFallbackInput {
  return {
    cwd: "/work/proj",
    trustDirectories: [],
    level: "danger-full-access",
    approval: "never",
    levelFromFile: true,
    approvalFromFile: true,
    interactive: false,
    ...overrides,
  };
}

/**
 * 恒返回 true 的信任确认回调（记录调用参数）
 * @param {string[]} calls - 调用记录收集器
 * @returns {(cwd: string) => Promise<boolean>} 确认回调
 */
function acceptPrompt(calls: string[]): (cwd: string) => Promise<boolean> {
  return async (cwd: string) => {
    calls.push(cwd);
    return true;
  };
}

/**
 * 恒返回 false 的信任确认回调（模拟用户拒绝）
 * @returns {(cwd: string) => Promise<boolean>} 确认回调
 */
function rejectPrompt(): (cwd: string) => Promise<boolean> {
  return async () => false;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-sandbox-assembly-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveUntrustedFallback", () => {
  it("已在信任目录内时返回 null（无需处理，不弹确认）", async () => {
    const calls: string[] = [];
    const result = await resolveUntrustedFallback(
      makeInput({ trustDirectories: ["/work"] }),
      acceptPrompt(calls),
    );
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it("无文件来源的危险配置时返回 null（CLI 传入的 full / never 不降级不询问）", async () => {
    const calls: string[] = [];
    const cliFull = await resolveUntrustedFallback(
      makeInput({ levelFromFile: false, approval: "on-failure", approvalFromFile: false }),
      acceptPrompt(calls),
    );
    expect(cliFull).toBeNull();
    const cliNever = await resolveUntrustedFallback(
      makeInput({ level: "read-only", levelFromFile: true, approval: "never", approvalFromFile: false }),
      acceptPrompt(calls),
    );
    expect(cliNever).toBeNull();
    const safeConfig = await resolveUntrustedFallback(
      makeInput({ level: "read-only", approval: "on-failure" }),
      acceptPrompt(calls),
    );
    expect(safeConfig).toBeNull();
    expect(calls).toEqual([]);
  });

  it("非交互环境不询问直接降级：full → workspace-write、never → on-failure", async () => {
    const calls: string[] = [];
    const result = await resolveUntrustedFallback(
      makeInput(),
      acceptPrompt(calls),
    );
    expect(result).not.toBeNull();
    expect(result?.granted).toBe(false);
    expect(result?.level).toBe("workspace-write");
    expect(result?.approval).toBe("on-failure");
    // 两个降级合并为一条警告说明
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain("未确认信任");
    expect(result?.warnings[0]).toContain("workspace-write");
    expect(result?.warnings[0]).toContain("on-failure");
    expect(calls).toEqual([]);
  });

  it("交互确认信任时按原值生效并提示写入全局配置", async () => {
    const calls: string[] = [];
    const result = await resolveUntrustedFallback(
      makeInput({ interactive: true }),
      acceptPrompt(calls),
    );
    expect(result).not.toBeNull();
    expect(result?.granted).toBe(true);
    expect(result?.level).toBe("danger-full-access");
    expect(result?.approval).toBe("never");
    expect(result?.warnings[0]).toContain("已信任当前目录 /work/proj");
    expect(calls).toEqual(["/work/proj"]);
  });

  it("交互拒绝信任时降级执行", async () => {
    const result = await resolveUntrustedFallback(
      makeInput({ interactive: true }),
      rejectPrompt(),
    );
    expect(result?.granted).toBe(false);
    expect(result?.level).toBe("workspace-write");
    expect(result?.approval).toBe("on-failure");
  });

  it("仅文件来源的 full 档时只降级档位，approval 保持原值", async () => {
    const result = await resolveUntrustedFallback(
      makeInput({ approval: "on-failure", approvalFromFile: false }),
      rejectPrompt(),
    );
    expect(result?.level).toBe("workspace-write");
    expect(result?.approval).toBe("on-failure");
    expect(result?.warnings[0]).not.toContain("never");
  });
});

describe("grantGlobalTrust", () => {
  it("写入空配置时创建 sandbox.trustDirectories 并保留文件其余段", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ llm: { model: "x" } }));
    grantGlobalTrust("/work/proj", configPath);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(raw.sandbox.trustDirectories).toEqual(["/work/proj"]);
    expect(raw.llm).toEqual({ model: "x" });
  });

  it("已存在的 trustDirectories 追加去重，sandbox 段其余字段保留", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        sandbox: { level: "read-only", trustDirectories: ["/work"] },
      }),
    );
    grantGlobalTrust("/work/proj", configPath);
    grantGlobalTrust("/work/proj", configPath);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(raw.sandbox.trustDirectories).toEqual(["/work", "/work/proj"]);
    expect(raw.sandbox.level).toBe("read-only");
  });

  it("trustDirectories 字段非法时从当前目录重建", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ sandbox: { trustDirectories: "not-array" } }),
    );
    grantGlobalTrust("/work/proj", configPath);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(raw.sandbox.trustDirectories).toEqual(["/work/proj"]);
  });

  it("配置文件不存在时创建并写入", () => {
    const configPath = join(dir, "nested", "config.json");
    grantGlobalTrust("/work/proj", configPath);
    expect(existsSync(configPath)).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(raw.sandbox.trustDirectories).toEqual(["/work/proj"]);
  });
});
