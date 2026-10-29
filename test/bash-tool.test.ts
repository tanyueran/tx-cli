import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../src/core/tools/builtin/bash";
import { wrapToolWithPermission } from "../src/core/tools/permission";
import { SandboxContext } from "../src/core/sandbox/runtime/context";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config/schema";
import { noopProvider } from "../src/core/sandbox/providers/backends/noop";
import type {
  ApprovalChoice,
  Approver,
  SandboxProvider,
  SandboxViolationInfo,
} from "../src/core/sandbox/types";
import type { SandboxFileConfig } from "../src/core/sandbox/config/schema";

/** 测试用临时目录 */
let dir: string;

/**
 * 记录调用的假审批器
 */
class FakeApprover implements Approver {
  /** ask 被调用的次数 */
  askCalls = 0;
  /** 升级问询被调用的次数 */
  escalateCalls = 0;
  /** ask 应答 */
  private readonly choice: ApprovalChoice;
  /** 升级应答 */
  private readonly escalateAnswer: boolean;

  /**
   * @param {ApprovalChoice} choice - ask 应答
   * @param {boolean} escalateAnswer - 升级问询应答
   */
  constructor(choice: ApprovalChoice = { kind: "once" }, escalateAnswer = false) {
    this.choice = choice;
    this.escalateAnswer = escalateAnswer;
  }

  /**
   * 记录调用并返回预设选择
   * @returns {Promise<ApprovalChoice>} 预设选择
   */
  async ask(): Promise<ApprovalChoice> {
    this.askCalls += 1;
    return this.choice;
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
 * @param {object} options - 上下文选项
 * @param {SandboxFileConfig["level"]} options.level - 沙箱档位
 * @param {SandboxFileConfig["approval"]} options.approval - 审批策略
 * @param {SandboxProvider | undefined} options.provider - 沙箱 Provider
 * @param {SandboxFileConfig["rules"]} options.rules - 权限规则
 * @param {Approver} options.approver - 审批器
 * @param {boolean} options.interactive - 是否可交互
 * @returns {SandboxContext} 上下文实例
 */
function makeContext(options: {
  level?: SandboxFileConfig["level"];
  approval?: SandboxFileConfig["approval"];
  provider?: SandboxProvider | null;
  rules?: SandboxFileConfig["rules"];
  approver?: Approver;
  interactive?: boolean;
} = {}): SandboxContext {
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    level: options.level ?? DEFAULT_SANDBOX_CONFIG.level,
    approval: options.approval ?? DEFAULT_SANDBOX_CONFIG.approval,
    rules: options.rules ?? DEFAULT_SANDBOX_CONFIG.rules,
  };
  // 显式传 null 表示 Provider 缺失（fail-closed）；未传默认 noop
  const provider =
    options.provider === null ? undefined : (options.provider ?? noopProvider);
  return new SandboxContext({
    config,
    level: options.level ?? config.level,
    approval: options.approval ?? config.approval,
    provider,
    isInteractive: options.interactive ?? true,
    approver: options.approver ?? new FakeApprover(),
    projectConfigPath: join(dir, "project-config.json"),
    auditPath: join(dir, "audit.jsonl"),
  });
}

/** 注定失败且带违规事件的假 Provider：wrapCommand 返回失败命令，annotateStderr 返回违规 */
const failingViolatingProvider: SandboxProvider = {
  name: "failing-violating",
  /** @returns {Promise<boolean>} 恒可用 */
  async isAvailable(): Promise<boolean> {
    return true;
  },
  /** @returns {Promise<void>} 空实现 */
  async initialize(): Promise<void> {
    // 测试桩：无初始化逻辑
  },
  /**
   * 返回注定失败的命令
   * @returns {Promise<string>} 固定失败命令
   */
  async wrapCommand(): Promise<string> {
    return "sh -c 'exit 7'";
  },
  /**
   * 返回伪造违规事件
   * @param {string} _commandId - 执行关联 ID（不使用）
   * @param {string} stderr - 原始 stderr
   * @returns {Promise<SandboxViolationInfo>} 含违规事件的标注结果
   */
  async annotateStderr(
    _commandId: string,
    stderr: string,
  ): Promise<SandboxViolationInfo> {
    return {
      annotatedStderr: `${stderr}\nwrite /etc/hosts: Operation not permitted`,
      events: ["write /etc/hosts: Operation not permitted"],
    };
  },
  /** @returns {Promise<void>} 空实现 */
  async dispose(): Promise<void> {
    // 测试桩：无清理逻辑
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-bash-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bash 工具执行", () => {
  it("danger-full-access 档直通执行命令", async () => {
    const context = makeContext({ level: "danger-full-access" });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("命令失败时 ok 为 false 且输出含退出码", async () => {
    const context = makeContext({ level: "danger-full-access" });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "sh -c 'exit 3'" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("3");
  });

  it("workspace-write 档经 Provider 包装执行", async () => {
    const context = makeContext({ level: "workspace-write" });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "echo wrapped" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("wrapped");
  });

  it("沙箱违规导致失败时回传违规说明供模型自纠", async () => {
    const context = makeContext({
      level: "workspace-write",
      approval: "never",
      provider: failingViolatingProvider,
    });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "true" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("沙箱拦截");
    expect(result.output).toContain("/etc/hosts");
  });

  it("on-failure 且违规时征询升级：批准后脱离沙箱重跑原命令", async () => {
    const approver = new FakeApprover({ kind: "once" }, true);
    const context = makeContext({
      level: "workspace-write",
      approval: "on-failure",
      provider: failingViolatingProvider,
      approver,
    });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "echo retry" });
    expect(approver.escalateCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("脱离沙箱重跑");
    expect(result.output).toContain("retry");
  });

  it("on-failure 且违规但用户拒绝升级时回传违规说明", async () => {
    const approver = new FakeApprover({ kind: "once" }, false);
    const context = makeContext({
      level: "workspace-write",
      approval: "on-failure",
      provider: failingViolatingProvider,
      approver,
    });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "true" });
    expect(approver.escalateCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("沙箱拦截");
  });

  it("never 策略下违规失败不征询升级", async () => {
    const approver = new FakeApprover({ kind: "once" }, true);
    const context = makeContext({
      level: "workspace-write",
      approval: "never",
      provider: failingViolatingProvider,
      approver,
    });
    const tool = createBashTool(context);
    await tool.execute({ command: "true" });
    expect(approver.escalateCalls).toBe(0);
  });

  it("Provider 缺失时失败关闭", async () => {
    const context = makeContext({
      level: "workspace-write",
      provider: null,
    });
    const tool = createBashTool(context);
    const result = await tool.execute({ command: "echo hi" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("沙箱不可用");
  });

  it("缺少 command 参数返回失败", async () => {
    const context = makeContext({ level: "danger-full-access" });
    const tool = createBashTool(context);
    const result = await tool.execute({});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("command");
  });

  it("子进程默认注入 NODE_USE_ENV_PROXY，让 Node 脚本也遵循代理环境变量", async () => {
    const saved = process.env.NODE_USE_ENV_PROXY;
    delete process.env.NODE_USE_ENV_PROXY;
    try {
      const context = makeContext({ level: "danger-full-access" });
      const tool = createBashTool(context);
      const result = await tool.execute({
        command: "printenv NODE_USE_ENV_PROXY || echo unset",
      });
      expect(result.output.trim()).toBe("1");
    } finally {
      if (saved !== undefined) {
        process.env.NODE_USE_ENV_PROXY = saved;
      }
    }
  });

  it("用户显式设置 NODE_USE_ENV_PROXY 时不覆盖", async () => {
    const saved = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = "0";
    try {
      const context = makeContext({ level: "danger-full-access" });
      const tool = createBashTool(context);
      const result = await tool.execute({
        command: "printenv NODE_USE_ENV_PROXY",
      });
      expect(result.output.trim()).toBe("0");
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_USE_ENV_PROXY;
      } else {
        process.env.NODE_USE_ENV_PROXY = saved;
      }
    }
  });

  it("超时被终止并返回超时说明", async () => {
    const context = makeContext({ level: "danger-full-access" });
    const tool = createBashTool(context);
    const result = await tool.execute({
      command: "sleep 30",
      timeout: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("超时");
  });
});

describe("bash 工具权限包装", () => {
  it("临时目录内的明确目标可实际递归清理", async () => {
    const target = join(dir, "cache-to-remove");
    const context = makeContext({ level: "workspace-write" });
    const wrapped = wrapToolWithPermission(createBashTool(context), context);
    const result = await wrapped.execute({
      command: `mkdir -p ${target} && rm -rf -- ${target} && test ! -e ${target}`,
    });
    expect(result.ok).toBe(true);
  });

  it("deny 规则命中时不执行命令直接拒绝", async () => {
    const context = makeContext({
      level: "danger-full-access",
      rules: { allow: [], ask: [], deny: ["Bash(echo:*)"] },
    });
    const wrapped = wrapToolWithPermission(createBashTool(context), context);
    const result = await wrapped.execute({ command: "echo blocked" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("已拒绝执行");
    expect(result.output).not.toContain("blocked");
  });

  it("ask 判定经审批后执行", async () => {
    const context = makeContext({
      level: "danger-full-access",
      rules: { allow: [], ask: ["Bash(echo:*)"], deny: [] },
      approver: new FakeApprover({ kind: "once" }),
    });
    const wrapped = wrapToolWithPermission(createBashTool(context), context);
    const result = await wrapped.execute({ command: "echo approved" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("approved");
  });

  it("ask 判定被拒绝时不执行命令", async () => {
    const context = makeContext({
      level: "danger-full-access",
      rules: { allow: [], ask: ["Bash(echo:*)"], deny: [] },
      approver: new FakeApprover({ kind: "deny" }),
    });
    const wrapped = wrapToolWithPermission(createBashTool(context), context);
    const result = await wrapped.execute({ command: "echo denied" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("用户拒绝");
    expect(result.output).not.toContain("denied\n");
  });

  it("未声明 permission 的工具不被包装", () => {
    const context = makeContext();
    const plain = {
      name: "plain",
      description: "无权限声明",
      parameters: { type: "object" as const, properties: {} },
      async execute() {
        return { ok: true, output: "done" };
      },
    };
    expect(wrapToolWithPermission(plain, context)).toBe(plain);
  });
});
