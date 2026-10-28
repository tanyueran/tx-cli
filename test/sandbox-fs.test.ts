import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchPathPattern,
} from "../src/core/sandbox/policy/path-match";
import { SandboxContext } from "../src/core/sandbox/runtime/context";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config/schema";
import { noopProvider } from "../src/core/sandbox/providers/backends/noop";
import {
  landlockProvider,
  __resetLandlockForTest,
} from "../src/core/sandbox/providers/backends/landlock";
import type { ApprovalChoice, Approver, TierConfig } from "../src/core/sandbox/types";
import type { SandboxFileConfig } from "../src/core/sandbox/config/schema";
import { wrapToolWithPermission } from "../src/core/tools/permission";
import { readFileTool } from "../src/core/tools/builtin/read-file";
import { webSearchTool } from "../src/core/tools/builtin/web-search";

/** 测试用临时目录 */
let dir: string;

/**
 * 一次性审批器：始终返回「本次允许」（fs 边界测试不关心审批分支）
 * @returns {Approver} 假审批器
 */
function alwaysOnceApprover(): Approver {
  return {
    /**
     * 返回本次允许
     * @returns {Promise<ApprovalChoice>} 预设选择
     */
    async ask(): Promise<ApprovalChoice> {
      return { kind: "once" };
    },
    /**
     * 拒绝升级
     * @returns {Promise<boolean>} false
     */
    async askEscalation(): Promise<boolean> {
      return false;
    },
  };
}

/**
 * 构造带 fs 边界注入的沙箱上下文
 * @param {TierConfig} tier - 注入的档位边界配置
 * @param {string} level - 档位（覆盖 config 与 tier 口径）
 * @returns {SandboxContext} 上下文实例
 */
function makeFsContext(
  tier: TierConfig,
  level: TierConfig["level"],
): SandboxContext {
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    level,
  };
  return new SandboxContext({
    config,
    level,
    approval: "on-failure",
    provider: noopProvider,
    isInteractive: true,
    approver: alwaysOnceApprover(),
    tier,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-sandbox-fs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TX_SANDBOX_LANDLOCK_HELPER;
  __resetLandlockForTest();
});

describe("matchPathPattern", () => {
  it("无通配符目录模式按前缀匹配子树", () => {
    expect(matchPathPattern("/a/b", "/a/b")).toBe(true);
    expect(matchPathPattern("/a/b", "/a/b/c.txt")).toBe(true);
    expect(matchPathPattern("/a/b", "/a/bc")).toBe(false);
    expect(matchPathPattern("/a/b", "/a/b2/c")).toBe(false);
  });

  it("单星不跨目录，双星跨目录", () => {
    expect(matchPathPattern("/a/*/c.ts", "/a/b/c.ts")).toBe(true);
    expect(matchPathPattern("/a/*/c.ts", "/a/b/d/c.ts")).toBe(false);
    expect(matchPathPattern("/a/**", "/a/b/d/c.ts")).toBe(true);
    expect(matchPathPattern("/a/**", "/x/b/c.ts")).toBe(false);
  });

  it("纯文件名模式命中任意目录下的同名文件", () => {
    expect(matchPathPattern(".env", "/project/.env")).toBe(true);
    expect(matchPathPattern(".env", "/project/nested/.env")).toBe(true);
    expect(matchPathPattern(".env", "/project/.envrc")).toBe(false);
    expect(matchPathPattern("*.pem", "/project/certs/key.pem")).toBe(true);
    expect(matchPathPattern("*.pem", "/project/key.txt")).toBe(false);
  });

  it("含斜杠的 glob 按完整路径匹配", () => {
    expect(matchPathPattern("/keys/*.pem", "/keys/server.pem")).toBe(true);
    expect(matchPathPattern("/keys/*.pem", "/other/server.pem")).toBe(false);
  });
});

describe("SandboxContext.checkFsRead", () => {
  it("denyRead 命中即拒绝并带原因", () => {
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [join(dir, "secret")],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    const verdict = context.checkFsRead(join(dir, "secret", "key"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("禁读边界");
  });

  it("未命中 denyRead 放行", () => {
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [join(dir, "secret")],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    expect(context.checkFsRead(join(dir, "normal.txt")).allowed).toBe(true);
  });

  it("含 .. 的伪装路径先规范化再匹配（防绕过 denyRead）", () => {
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [join(dir, "secret")],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    // dir/other/../secret/key 规范化后落入 denyRead 子树，必须被拒绝；
    // 未规范化时字符串不以 denyRead 前缀开头会被误放行
    const verdict = context.checkFsRead(
      join(dir, "other", "..", "secret", "key"),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("禁读边界");
  });

  it("danger-full-access 档跳过检查", () => {
    const tier: TierConfig = {
      level: "danger-full-access",
      denyRead: ["/"],
      allowWrite: [],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "danger-full-access");
    expect(context.checkFsRead("/etc/passwd").allowed).toBe(true);
  });
});

describe("SandboxContext.checkFsWrite", () => {
  it("read-only 档（无可写根）拒绝一切写入", () => {
    const tier: TierConfig = {
      level: "read-only",
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "read-only");
    const verdict = context.checkFsWrite(join(dir, "out.txt"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("禁止一切文件写入");
  });

  it("workspace-write 档可写根之外拒绝", () => {
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    const verdict = context.checkFsWrite("/etc/passwd");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("不在可写范围");
  });

  it("可写根内命中禁写模式（.env）拒绝", () => {
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [],
      allowWrite: [dir],
      denyWrite: [".env"],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    const verdict = context.checkFsWrite(join(dir, ".env"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("禁写模式");
    expect(context.checkFsWrite(join(dir, "ok.txt")).allowed).toBe(true);
  });
});

describe("fs 工具的权限门卫包装", () => {
  it("read_file 命中 denyRead 边界时被拦截（返回失败且不读文件）", async () => {
    const secretDir = join(dir, "secret");
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [secretDir],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    const wrapped = wrapToolWithPermission(readFileTool, context);
    const result = await wrapped.execute({
      path: join(secretDir, "key.txt"),
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("已拒绝访问");
  });

  it("read_file 未命中边界时正常读取", async () => {
    const target = join(dir, "note.txt");
    writeFileSync(target, "hello");
    const tier: TierConfig = {
      level: "workspace-write",
      denyRead: [join(dir, "secret")],
      allowWrite: [dir],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
    const context = makeFsContext(tier, "workspace-write");
    const wrapped = wrapToolWithPermission(readFileTool, context);
    const result = await wrapped.execute({ path: target });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("web_search 的 deny 规则在执行前拦截（不发起网络请求）", async () => {
    const config: SandboxFileConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      rules: { allow: [], ask: [], deny: ["WebSearch"] },
    };
    const context = new SandboxContext({
      config,
      level: "workspace-write",
      approval: "on-failure",
      provider: noopProvider,
      isInteractive: true,
      approver: alwaysOnceApprover(),
      projectConfigPath: join(dir, "project-config.json"),
      auditPath: join(dir, "audit.jsonl"),
    });
    const wrapped = wrapToolWithPermission(webSearchTool, context);
    const result = await wrapped.execute({ query: "天气" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("已拒绝执行");
  });

  it("web_search 非交互 ask 判定按拒绝处理（不发起网络请求）", async () => {
    const config: SandboxFileConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      rules: { allow: [], ask: ["WebSearch"], deny: [] },
    };
    const context = new SandboxContext({
      config,
      level: "workspace-write",
      approval: "on-failure",
      provider: noopProvider,
      isInteractive: false,
      approver: alwaysOnceApprover(),
      projectConfigPath: join(dir, "project-config.json"),
      auditPath: join(dir, "audit.jsonl"),
    });
    const wrapped = wrapToolWithPermission(webSearchTool, context);
    const result = await wrapped.execute({ query: "新闻" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("非交互");
  });

  it("read-only 档下 web_search（只读检索）未命中规则默认放行（口径对齐 MCP 只读工具）", () => {
    const config: SandboxFileConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      level: "read-only",
      rules: { allow: [], ask: [], deny: [] },
    };
    const context = new SandboxContext({
      config,
      level: "read-only",
      approval: "on-failure",
      provider: noopProvider,
      isInteractive: false,
      approver: alwaysOnceApprover(),
      projectConfigPath: join(dir, "project-config.json"),
      auditPath: join(dir, "audit.jsonl"),
    });
    // 只读检索工具无外部副作用：默认放行，不再要求审批（避免非交互环境 fail-closed）；
    // 断言判定结果而非执行工具，避免用例真实发起网络请求
    const evaluation = context.evaluate(
      "web_search",
      "web_search(新闻)",
      ["net"],
      undefined,
      true,
    );
    expect(evaluation.decision).toBe("allow");
  });

  it("read-only 档下 web_search 在 always-ask 策略下仍逐次询问", () => {
    const config: SandboxFileConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      level: "read-only",
      rules: { allow: [], ask: [], deny: [] },
    };
    const context = new SandboxContext({
      config,
      level: "read-only",
      approval: "always-ask",
      provider: noopProvider,
      isInteractive: false,
      approver: alwaysOnceApprover(),
      projectConfigPath: join(dir, "project-config.json"),
      auditPath: join(dir, "audit.jsonl"),
    });
    const evaluation = context.evaluate(
      "web_search",
      "web_search(新闻)",
      ["net"],
      undefined,
      true,
    );
    expect(evaluation.decision).toBe("ask");
    expect(evaluation.matchedRule).toBe("web_search(新闻)");
  });
});

describe("工具规则键生成", () => {
  it("fs 工具以绝对路径为规则键主体", () => {
    const key = readFileTool.permission?.ruleKey({ path: "src/a.ts" });
    expect(key).toMatch(/^read_file\(\/.+\/src\/a\.ts\)$/);
  });

  it("web_search 以关键词为细粒度主体", () => {
    expect(webSearchTool.permission?.ruleKey({ query: "天气" })).toBe(
      "web_search(天气)",
    );
  });
});

describe("landlockProvider", () => {
  it("未配置 helper 且非 Linux 环境时不可用", async () => {
    delete process.env.TX_SANDBOX_LANDLOCK_HELPER;
    // macOS/测试环境下无显式 helper 时应探测失败（Linux 环境由 CI 矩阵覆盖）
    if (process.platform !== "linux") {
      await expect(landlockProvider.isAvailable()).resolves.toBe(false);
    }
  });

  it("显式指定可执行 helper 时可用", async () => {
    const helper = join(dir, "landlock-exec");
    writeFileSync(helper, "#!/bin/sh\nexec \"$@\"\n");
    chmodSync(helper, 0o755);
    process.env.TX_SANDBOX_LANDLOCK_HELPER = helper;
    await expect(landlockProvider.isAvailable()).resolves.toBe(true);
  });

  it("显式指定的 helper 不存在时不可用", async () => {
    process.env.TX_SANDBOX_LANDLOCK_HELPER = join(dir, "missing");
    await expect(landlockProvider.isAvailable()).resolves.toBe(false);
  });

  it("read-only 档包装为 helper 调用且只带只读根", async () => {
    const helper = join(dir, "landlock-exec");
    writeFileSync(helper, "#!/bin/sh\nexec \"$@\"\n");
    chmodSync(helper, 0o755);
    process.env.TX_SANDBOX_LANDLOCK_HELPER = helper;
    await landlockProvider.initialize({
      level: "read-only",
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    });
    const wrapped = await landlockProvider.wrapCommand("cat a.txt", {
      commandId: "id-1",
      commandText: "cat a.txt",
    });
    expect(wrapped).toContain("--ro-paths");
    expect(wrapped).not.toContain("--rw-paths");
    expect(wrapped.endsWith("-- cat a.txt")).toBe(true);
  });

  it("workspace-write 档包装带只读根与可写根", async () => {
    const helper = join(dir, "landlock-exec");
    writeFileSync(helper, "#!/bin/sh\nexec \"$@\"\n");
    chmodSync(helper, 0o755);
    process.env.TX_SANDBOX_LANDLOCK_HELPER = helper;
    await landlockProvider.initialize({
      level: "workspace-write",
      denyRead: [],
      allowWrite: ["/work", "/tmp"],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    });
    const wrapped = await landlockProvider.wrapCommand("echo hi", {
      commandId: "id-2",
      commandText: "echo hi",
    });
    expect(wrapped).toContain(`--ro-paths '/'`);
    expect(wrapped).toContain(`--rw-paths '/work,/tmp'`);
    expect(wrapped.endsWith("-- echo hi")).toBe(true);
  });

  it("annotateStderr 透传原文且无违规事件", async () => {
    const info = await landlockProvider.annotateStderr("id-3", "boom");
    expect(info.annotatedStderr).toBe("boom");
    expect(info.events).toEqual([]);
  });
});
