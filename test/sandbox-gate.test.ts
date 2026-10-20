import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxContext } from "../src/core/sandbox/gate";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config";
import { noopProvider } from "../src/core/sandbox/providers/noop";
import type { ApprovalChoice, Approver } from "../src/core/sandbox/types";
import type { SandboxFileConfig } from "../src/core/sandbox/config";

/** 测试用临时目录 */
let dir: string;

/** 可编程的假审批器：按预设队列返回选择 */
class FakeApprover implements Approver {
  /** ask 被调用的次数 */
  askCalls = 0;
  /** askEscalation 被调用的次数 */
  escalateCalls = 0;
  /** 预设的 ask 应答队列（耗尽后重复最后一项） */
  private readonly queue: ApprovalChoice[];
  /** 预设的升级应答 */
  private readonly escalateAnswer: boolean;

  /**
   * @param {ApprovalChoice[]} queue - ask 应答队列
   * @param {boolean} escalateAnswer - 升级问询应答
   */
  constructor(queue: ApprovalChoice[], escalateAnswer = false) {
    this.queue = queue;
    this.escalateAnswer = escalateAnswer;
  }

  /**
   * 记录调用并返回队首选择
   * @returns {Promise<ApprovalChoice>} 预设选择
   */
  async ask(): Promise<ApprovalChoice> {
    this.askCalls += 1;
    return this.queue[Math.min(this.askCalls - 1, this.queue.length - 1)];
  }

  /**
   * 记录调用并返回预设应答
   * @returns {Promise<boolean>} 预设应答
   */
  async askEscalation(): Promise<boolean> {
    this.escalateCalls += 1;
    return this.escalateAnswer;
  }
}

/**
 * 构造测试用沙箱上下文
 * @param {object} overrides - 配置覆盖项
 * @param {Approver} approver - 审批器
 * @param {boolean} interactive - 是否可交互
 * @returns {SandboxContext} 上下文实例
 */
function makeContext(
  overrides: Partial<SandboxFileConfig> = {},
  approver: Approver = new FakeApprover([{ kind: "once" }]),
  interactive = true,
): SandboxContext {
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...overrides,
    rules: { ...DEFAULT_SANDBOX_CONFIG.rules, ...overrides.rules },
  };
  return new SandboxContext({
    config,
    level: config.level,
    approval: config.approval,
    provider: noopProvider,
    isInteractive: interactive,
    approver,
    grantsPath: join(dir, "grants.json"),
    auditPath: join(dir, "audit.jsonl"),
  });
}

/** 读取审计行 */
function readAuditLines(): string[] {
  const path = join(dir, "audit.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-sandbox-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SandboxContext.guard", () => {
  it("deny 判定返回失败输出并写审计", async () => {
    const context = makeContext({
      rules: { allow: [], ask: [], deny: ["Bash(rm -rf:*)"] },
    });
    const blocked = await context.guard("bash", "bash(rm -rf /tmp/x)");
    expect(blocked).not.toBeNull();
    expect(blocked?.ok).toBe(false);
    expect(blocked?.output).toContain("已拒绝执行");
    const lines = readAuditLines();
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).decision).toBe("deny");
  });

  it("allow 判定直接放行（返回 null，不写审批审计）", async () => {
    const context = makeContext({
      rules: { allow: ["Bash(git status)"], ask: [], deny: [] },
    });
    const blocked = await context.guard("bash", "bash(git status)");
    expect(blocked).toBeNull();
    expect(readAuditLines().length).toBe(0);
  });

  it("ask 判定 + 批准一次 → 放行且后续同命令仍询问", async () => {
    const approver = new FakeApprover([{ kind: "once" }]);
    const context = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      approver,
    );
    expect(await context.guard("bash", "bash(git status)")).toBeNull();
    expect(await context.guard("bash", "bash(git status)")).toBeNull();
    expect(approver.askCalls).toBe(2);
  });

  it("ask 判定 + 本会话允许 → 后续同规则不再询问", async () => {
    const approver = new FakeApprover([{ kind: "session" }]);
    const context = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      approver,
    );
    expect(await context.guard("bash", "bash(git status)")).toBeNull();
    expect(await context.guard("bash", "bash(git status)")).toBeNull();
    expect(approver.askCalls).toBe(1);
  });

  it("ask 判定 + 始终允许 → 授权写入 grants 文件", async () => {
    const approver = new FakeApprover([{ kind: "always" }]);
    const context = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      approver,
    );
    expect(await context.guard("bash", "bash(git status)")).toBeNull();
    const grants = JSON.parse(
      readFileSync(join(dir, "grants.json"), "utf-8"),
    );
    expect(grants.allow).toEqual(["Bash(git status)"]);
  });

  it("grants 文件中的授权在新上下文中生效", async () => {
    const approver = new FakeApprover([{ kind: "always" }]);
    const first = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      approver,
    );
    await first.guard("bash", "bash(git status)");
    // 新上下文读取同一 grants 文件：不再询问
    const second = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      new FakeApprover([{ kind: "once" }]),
    );
    expect(await second.guard("bash", "bash(git status)")).toBeNull();
  });

  it("ask 判定 + 用户拒绝 → 返回失败输出", async () => {
    const approver = new FakeApprover([{ kind: "deny" }]);
    const context = makeContext(
      { rules: { allow: [], ask: ["Bash(git push:*)"], deny: [] } },
      approver,
    );
    const blocked = await context.guard("bash", "bash(git push)");
    expect(blocked?.ok).toBe(false);
    expect(blocked?.output).toContain("用户拒绝");
  });

  it("ask 判定 + 非交互环境 → 直接拒绝（fail-closed）", async () => {
    const approver = new FakeApprover([{ kind: "once" }]);
    const context = makeContext(
      { rules: { allow: [], ask: ["Bash(git status)"], deny: [] } },
      approver,
      false,
    );
    const blocked = await context.guard("bash", "bash(git status)");
    expect(blocked?.ok).toBe(false);
    expect(blocked?.output).toContain("非交互");
    expect(approver.askCalls).toBe(0);
    const lines = readAuditLines();
    expect(JSON.parse(lines[0]).decision).toBe("denied-noninteractive");
  });

  it("audit 关闭时不写审计文件", async () => {
    const context = makeContext({
      audit: false,
      rules: { allow: [], ask: [], deny: ["Bash(rm -rf:*)"] },
    });
    await context.guard("bash", "bash(rm -rf /tmp/x)");
    expect(readAuditLines().length).toBe(0);
  });
});

describe("SandboxContext.runSerial", () => {
  it("串行任务按提交顺序依次完成", async () => {
    const context = makeContext();
    const order: number[] = [];
    const makeJob = (id: number, delayMs: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(id);
      return id;
    };
    // 先提交慢任务再提交快任务：串行下仍按提交顺序完成
    await Promise.all([
      context.runSerial(makeJob(1, 40)),
      context.runSerial(makeJob(2, 1)),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("前序失败不阻断后续任务", async () => {
    const context = makeContext();
    const first = context.runSerial(async () => {
      throw new Error("boom");
    });
    await first.catch(() => undefined);
    const second = await context.runSerial(async () => "ok");
    expect(second).toBe("ok");
  });
});

describe("SandboxContext.evaluate", () => {
  it("bash 工具走复合命令判定：危险段导致整条拒绝", () => {
    const context = makeContext();
    const evaluation = context.evaluate("bash", "bash(echo hi && rm -rf /)");
    expect(evaluation.decision).toBe("deny");
  });

  it("非 bash 工具走规则键判定", () => {
    const context = makeContext({
      rules: { allow: ["web_search"], ask: [], deny: [] },
    });
    const evaluation = context.evaluate("web_search", "websearch");
    expect(evaluation.decision).toBe("allow");
  });
});
