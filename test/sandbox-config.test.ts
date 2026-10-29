import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSandboxConfig,
} from "../src/core/sandbox/config/load";
import { appendProjectGrant } from "../src/core/sandbox/config/grants";
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
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: join(dir, "config.json"),
    });
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
    const { config, warnings } = loadSandboxConfig({ globalConfigPath: path });
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
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: path,
    });
    expect(config.level).toBe(DEFAULT_SANDBOX_CONFIG.level);
    expect(config.approval).toBe(DEFAULT_SANDBOX_CONFIG.approval);
    expect(config.filesystem.denyRead).toEqual([]);
    expect(config.bash.timeoutMs).toBe(DEFAULT_SANDBOX_CONFIG.bash.timeoutMs);
    expect(warnings.length).toBe(4);
  });

  it("sandbox 段不是对象时忽略整段", () => {
    writeConfig({ sandbox: [1, 2] });
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: join(dir, "config.json"),
    });
    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(warnings[0]).toContain("必须是对象");
  });

  it("配置文件损坏时透传读取警告", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{broken");
    const { warnings } = loadSandboxConfig({ globalConfigPath: path });
    expect(warnings[0]).toContain("解析失败");
  });

  it("项目配置仅可收紧：放宽类字段忽略并警告，收紧类数组保持并集", () => {
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
          trustDirectories: ["~/proj"],
          filesystem: { denyWrite: ["*.pem"], writableRoots: ["~/data"] },
          network: { allowedDomains: ["github.com"] },
          rules: { allow: ["Bash(npm test)"] },
        },
      }),
    );
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    // 放宽类标量：项目 workspace-write 比全局 read-only 宽松 → 忽略
    expect(config.level).toBe("read-only");
    // 放宽类数组：信任目录 / 可写根 / 网络白名单仅可由全局提供 → 项目项忽略
    expect(config.trustDirectories).toEqual(["~/work"]);
    expect(config.filesystem.writableRoots).toEqual([]);
    expect(config.network.allowedDomains).toEqual(["npmjs.com"]);
    // 收紧类数组：denyWrite 并集、rules.allow 并集（承载会话授权落盘）
    expect(config.filesystem.denyWrite).toEqual(["*.key", "*.pem"]);
    expect(config.rules.allow).toEqual(["Bash(git status)", "Bash(npm test)"]);
    // 未受项目影响的字段保留全局值
    expect(config.approval).toBe("never");
    expect(config.bash.timeoutMs).toBe(30_000);
    expect(config.rules.deny).toEqual(["Bash(rm:*)"]);
    // 每个被忽略的放宽项均有对应警告
    expect(
      warnings.some((w) => w.includes("sandbox.level") && w.includes("更宽松")),
    ).toBe(true);
    expect(warnings.some((w) => w.includes("sandbox.trustDirectories"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("writableRoots"))).toBe(true);
    expect(warnings.some((w) => w.includes("allowedDomains"))).toBe(true);
    expect(warnings.some((w) => w.includes("已加载项目配置"))).toBe(true);
  });

  it("项目配置更严格时逐项生效且无忽略警告", () => {
    const globalPath = writeConfig({
      sandbox: {
        level: "workspace-write",
        approval: "never",
        provider: "srt",
        builtinDangerRules: false,
        audit: false,
        bash: { enabled: true, timeoutMs: 30_000 },
      },
    });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        sandbox: {
          level: "read-only",
          approval: "always-ask",
          provider: "noop",
          builtinDangerRules: true,
          audit: true,
          bash: { enabled: false, timeoutMs: 60_000 },
        },
      }),
    );
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    expect(config.level).toBe("read-only");
    expect(config.approval).toBe("always-ask");
    expect(config.provider).toBe("noop");
    expect(config.builtinDangerRules).toBe(true);
    expect(config.audit).toBe(true);
    expect(config.bash.enabled).toBe(false);
    expect(config.bash.timeoutMs).toBe(60_000);
    expect(warnings.some((w) => w.includes("已忽略"))).toBe(false);
  });

  it("放宽类标量逐项忽略并各自警告", () => {
    const globalPath = writeConfig({
      sandbox: {
        enabled: true,
        builtinDangerRules: true,
        audit: true,
        bash: { enabled: false },
      },
    });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        sandbox: {
          enabled: false,
          builtinDangerRules: false,
          audit: false,
          bash: { enabled: true },
        },
      }),
    );
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    expect(config.enabled).toBe(true);
    expect(config.builtinDangerRules).toBe(true);
    expect(config.audit).toBe(true);
    expect(config.bash.enabled).toBe(false);
    const ignored = warnings.filter((w) => w.includes("已忽略项目配置的"));
    expect(ignored.length).toBe(4);
    expect(warnings.some((w) => w.includes("sandbox.enabled"))).toBe(true);
    expect(warnings.some((w) => w.includes("sandbox.builtinDangerRules"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("sandbox.audit"))).toBe(true);
    expect(warnings.some((w) => w.includes("sandbox.bash.enabled"))).toBe(true);
  });

  it("项目配置文件缺失时跳过项目层且无项目加载告警", () => {
    const globalPath = writeConfig({ sandbox: { level: "read-only" } });
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: join(dir, "missing.json"),
    });
    expect(config.level).toBe("read-only");
    expect(warnings).toEqual([]);
  });

  it("项目文件存在但无 sandbox 段时保留全局配置且不告警", () => {
    const globalPath = writeConfig({ sandbox: { level: "read-only" } });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(projectPath, JSON.stringify({ llm: { model: "x" } }));
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    expect(config.level).toBe("read-only");
    expect(warnings).toEqual([]);
  });
});

describe("mcp.rules 段", () => {
  it("mcp.rules 规则解析生效：短格式自动补 mcp__ 前缀，带前缀写法原样保留", () => {
    const path = writeConfig({
      mcp: {
        rules: {
          allow: ["Chrome_DevTools_MCP__*", "mcp__github__*"],
          deny: ["untrusted_server__*"],
        },
      },
    });
    const { config, warnings } = loadSandboxConfig({ globalConfigPath: path });
    expect(warnings).toEqual([]);
    expect(config.rules.allow).toEqual([
      "mcp__Chrome_DevTools_MCP__*",
      "mcp__github__*",
    ]);
    expect(config.rules.deny).toEqual(["mcp__untrusted_server__*"]);
  });

  it("mcp.rules 与 sandbox.rules 同文件合并进同一组规则并去重", () => {
    const path = writeConfig({
      sandbox: { rules: { allow: ["Bash(git status)", "mcp__github__*"] } },
      mcp: { rules: { allow: ["mcp__github__*"] } },
    });
    const { config, warnings } = loadSandboxConfig({ globalConfigPath: path });
    expect(warnings).toEqual([]);
    expect(config.rules.allow).toEqual(["Bash(git status)", "mcp__github__*"]);
  });

  it("两级合并：全局与项目的 mcp.rules 并集去重（全局在前、项目在后）", () => {
    const globalPath = writeConfig({
      mcp: { rules: { allow: ["mcp__a__*"] } },
    });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        mcp: { rules: { allow: ["mcp__b__*"], deny: ["mcp__evil__*"] } },
      }),
    );
    const { config, warnings } = loadSandboxConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });
    expect(config.rules.allow).toEqual(["mcp__a__*", "mcp__b__*"]);
    expect(config.rules.deny).toEqual(["mcp__evil__*"]);
    expect(warnings.some((w) => w.includes("已加载项目配置"))).toBe(true);
  });

  it("mcp 段或规则非法时跳过并警告，不影响其余配置", () => {
    const path = writeConfig({
      sandbox: { level: "workspace-write" },
      mcp: { rules: { allow: "not-array", deny: [42] } },
    });
    const { config, warnings } = loadSandboxConfig({ globalConfigPath: path });
    expect(config.level).toBe("workspace-write");
    expect(config.rules.allow).toEqual([]);
    expect(warnings.some((w) => w.includes("mcp.rules.allow 必须是字符串数组"))).toBe(true);
  });

  it("mcp 段不是对象时忽略整段", () => {
    const path = writeConfig({ mcp: [1, 2] });
    const { config, warnings } = loadSandboxConfig({ globalConfigPath: path });
    expect(config.rules).toEqual({ allow: [], ask: [], deny: [] });
    expect(warnings[0]).toContain("mcp 段必须是对象");
  });
});

describe("appendProjectGrant", () => {
  it("mcp__ 前缀规则落盘 mcp.rules.allow，其余字段保留", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ sandbox: { level: "read-only" } }),
    );
    appendProjectGrant(dir, "mcp__github__*", path);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    expect(raw.mcp.rules.allow).toEqual(["mcp__github__*"]);
    expect(raw.sandbox.level).toBe("read-only");
  });

  it("非 mcp 规则落盘 sandbox.rules.allow，不创建 mcp 段", () => {
    const path = join(dir, "config.json");
    appendProjectGrant(dir, "bash(git status:*)", path);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    expect(raw.sandbox.rules.allow).toEqual(["bash(git status:*)"]);
    expect(raw.mcp).toBeUndefined();
  });

  it("重复规则不重复写入", () => {
    const path = join(dir, "config.json");
    appendProjectGrant(dir, "mcp__github__*", path);
    appendProjectGrant(dir, "mcp__github__*", path);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    expect(raw.mcp.rules.allow).toEqual(["mcp__github__*"]);
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

  it("workspace-write 档放行系统共享临时目录 /tmp（os.tmpdir 在 macOS 不覆盖它）", () => {
    if (process.platform === "win32") {
      return;
    }
    const tier = buildTierConfig(
      "workspace-write",
      DEFAULT_SANDBOX_CONFIG,
      "/work/proj",
    );
    expect(tier.allowWrite).toContain(tmpdir());
    expect(tier.allowWrite).toContain("/tmp");
    // macOS 上 /tmp 是指向 /private/tmp 的软链接，真实路径也要放行
    if (process.platform === "darwin") {
      expect(tier.allowWrite).toContain("/private/tmp");
    }
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
