import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSandboxConfig,
} from "../src/core/sandbox/config/load";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config/schema";
import { buildTierConfig } from "../src/core/sandbox/policy/tier";

/** 测试用临时目录 */
let dir: string;

/**
 * 在临时目录写入配置文件并返回路径
 * @param {Record<string, unknown>} content - 配置全文
 * @returns {string} 配置文件路径
 */
function writeConfig(content: Record<string, unknown>): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-sandbox-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadSandboxConfig", () => {
  it("无 sandbox 段时返回默认配置", () => {
    writeConfig({ llm: { model: "x" } });
    const { config, warnings } = loadSandboxConfig(join(dir, "config.json"));
    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("合法配置逐项生效", () => {
    const path = writeConfig({
      sandbox: {
        enabled: true,
        level: "workspace-write",
        approval: "never",
        provider: "noop",
        trustDirectories: ["~/work"],
        builtinDangerRules: false,
        filesystem: {
          denyRead: ["~/.config"],
          denyWrite: ["*.key"],
          writableRoots: ["~/data"],
        },
        network: { allowedDomains: ["npmjs.com"] },
        bash: { enabled: true, timeoutMs: 60_000 },
        rules: {
          allow: ["Bash(git status)"],
          ask: ["Bash(git push:*)"],
          deny: ["Bash(rm:*)"],
        },
        audit: false,
      },
    });
    const { config, warnings } = loadSandboxConfig(path);
    expect(warnings).toEqual([]);
    expect(config.level).toBe("workspace-write");
    expect(config.approval).toBe("never");
    expect(config.provider).toBe("noop");
    expect(config.trustDirectories).toEqual(["~/work"]);
    expect(config.builtinDangerRules).toBe(false);
    expect(config.filesystem.denyRead).toEqual(["~/.config"]);
    expect(config.filesystem.denyWrite).toEqual(["*.key"]);
    expect(config.filesystem.writableRoots).toEqual(["~/data"]);
    expect(config.network.allowedDomains).toEqual(["npmjs.com"]);
    expect(config.bash.timeoutMs).toBe(60_000);
    expect(config.rules.allow).toEqual(["Bash(git status)"]);
    expect(config.audit).toBe(false);
  });

  it("非法字段跳过并记录警告，其余字段生效", () => {
    const path = writeConfig({
      sandbox: {
        level: "full-access",
        approval: 42,
        filesystem: { denyRead: "not-array" },
        bash: { timeoutMs: 10 },
      },
    });
    const { config, warnings } = loadSandboxConfig(path);
    expect(config.level).toBe(DEFAULT_SANDBOX_CONFIG.level);
    expect(config.approval).toBe(DEFAULT_SANDBOX_CONFIG.approval);
    expect(config.filesystem.denyRead).toEqual([]);
    expect(config.bash.timeoutMs).toBe(DEFAULT_SANDBOX_CONFIG.bash.timeoutMs);
    expect(warnings.length).toBe(4);
  });

  it("sandbox 段不是对象时忽略整段", () => {
    writeConfig({ sandbox: [1, 2] });
    const { config, warnings } = loadSandboxConfig(join(dir, "config.json"));
    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(warnings[0]).toContain("必须是对象");
  });

  it("配置文件损坏时透传读取警告", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{broken");
    const { warnings } = loadSandboxConfig(path);
    expect(warnings[0]).toContain("解析失败");
  });

  it("两级合并：标量项目覆盖全局，数组并集去重（全局在前、项目在后）", () => {
    const globalPath = writeConfig({
      sandbox: {
        level: "read-only",
        approval: "never",
        trustDirectories: ["~/work"],
        filesystem: { denyWrite: ["*.key"] },
        network: { allowedDomains: ["npmjs.com"] },
        bash: { timeoutMs: 30_000 },
        rules: { allow: ["Bash(git status)"], deny: ["Bash(rm:*)"] },
      },
    });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        sandbox: {
          level: "workspace-write",
          trustDirectories: ["~/work", "~/proj"],
          filesystem: { denyWrite: ["*.pem"] },
          network: { allowedDomains: ["github.com"] },
          rules: { allow: ["Bash(npm test)"] },
        },
      }),
    );
    const { config, warnings } = loadSandboxConfig(globalPath, projectPath);
    // 标量：项目覆盖全局（level），项目未配置时保留全局（approval、bash.timeoutMs）
    expect(config.level).toBe("workspace-write");
    expect(config.approval).toBe("never");
    expect(config.bash.timeoutMs).toBe(30_000);
    // 数组：并集去重，全局在前、项目在后
    expect(config.trustDirectories).toEqual(["~/work", "~/proj"]);
    expect(config.filesystem.denyWrite).toEqual(["*.key", "*.pem"]);
    expect(config.network.allowedDomains).toEqual(["npmjs.com", "github.com"]);
    expect(config.rules.allow).toEqual(["Bash(git status)", "Bash(npm test)"]);
    expect(config.rules.deny).toEqual(["Bash(rm:*)"]);
    expect(warnings.some((w) => w.includes("已加载项目配置"))).toBe(true);
  });

  it("项目配置文件缺失时跳过项目层且无项目加载告警", () => {
    const globalPath = writeConfig({ sandbox: { level: "read-only" } });
    const { config, warnings } = loadSandboxConfig(
      globalPath,
      join(dir, "missing.json"),
    );
    expect(config.level).toBe("read-only");
    expect(warnings).toEqual([]);
  });

  it("项目文件存在但无 sandbox 段时保留全局配置且不告警", () => {
    const globalPath = writeConfig({ sandbox: { level: "read-only" } });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(projectPath, JSON.stringify({ llm: { model: "x" } }));
    const { config, warnings } = loadSandboxConfig(globalPath, projectPath);
    expect(config.level).toBe("read-only");
    expect(warnings).toEqual([]);
  });
});

describe("buildTierConfig", () => {
  it("read-only 档全禁写全禁网且禁读凭据目录", () => {
    const tier = buildTierConfig(
      "read-only",
      DEFAULT_SANDBOX_CONFIG,
      "/work/proj",
    );
    expect(tier.allowWrite).toEqual([]);
    expect(tier.allowedDomains).toEqual([]);
    expect(tier.denyRead.some((p) => p.endsWith("/.ssh"))).toBe(true);
  });

  it("workspace-write 档可写 cwd 与临时目录并禁写敏感文件", () => {
    const tier = buildTierConfig(
      "workspace-write",
      DEFAULT_SANDBOX_CONFIG,
      "/work/proj",
    );
    expect(tier.allowWrite).toContain("/work/proj");
    expect(tier.denyWrite).toContain(".env");
    expect(tier.denyWrite).toContain("*.pem");
  });

  it("用户扩展限制合并进档位默认", () => {
    const config = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: {
        denyRead: ["~/.config"],
        denyWrite: ["*.key"],
        writableRoots: ["~/data"],
      },
      network: { allowedDomains: ["npmjs.com"] },
    };
    const tier = buildTierConfig("workspace-write", config, "/work/proj");
    expect(tier.denyRead.some((p) => p.endsWith("/.config"))).toBe(true);
    expect(tier.denyWrite).toContain("*.key");
    expect(tier.allowWrite.some((p) => p.endsWith("/data"))).toBe(true);
    expect(tier.allowedDomains).toEqual(["npmjs.com"]);
  });
});
