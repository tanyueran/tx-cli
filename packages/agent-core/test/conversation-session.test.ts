/**
 * ConversationSession 单测：无头多轮会话的回合编排、历史回滚、后台事件注入、
 * 清空/导出/释放等通用能力（终端 REPL 行为不在本文件范围）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConversationSession } from "@tanyueran/agent-core/conversation/session/conversation-session";
import type { ConversationRuntime } from "@tanyueran/agent-core/conversation/session/runtime";
import { executeConversationTurn } from "@tanyueran/agent-core/conversation/loop/execute-turn";
import { attachSubAgentIfEnabled } from "@tanyueran/agent-core/conversation/sub-agent/attach";
import { maybeCompactHistory } from "@tanyueran/agent-core/conversation/loop/compaction";
import { writeSessionMarkdown } from "@tanyueran/agent-core/conversation/session/session-export";
import { disposeConversationRuntime } from "@tanyueran/agent-core/conversation/session/runtime";
import { CancelError, CliError } from "@tanyueran/agent-common";
import type { LlmConfig, TokenUsage } from "@tanyueran/agent-core/llm/types";
import type { SubAgentNodeEvent } from "@tanyueran/agent-core/conversation/sub-agent/dispatcher";
import { createMockChannels } from "./helpers/mock-channels";

// 运行时装配替换为内存假对象：MCP / 沙箱 / 技能装配不属于本文件测试范围
vi.mock("@tanyueran/agent-core/conversation/session/runtime", () => ({
  createConversationRuntime: vi.fn(),
  disposeConversationRuntime: vi.fn(),
}));

// 回合执行替换为可控 mock：默认写入一条用户消息并上报一次用量
vi.mock("@tanyueran/agent-core/conversation/loop/execute-turn", () => ({
  executeConversationTurn: vi.fn(),
}));

// 子 Agent 装配替换为可控句柄与调度器
vi.mock("@tanyueran/agent-core/conversation/sub-agent/attach", () => ({
  attachSubAgentIfEnabled: vi.fn(),
}));

// 压缩判定默认不介入（真实 formatCompactionNotice 保留）
vi.mock("@tanyueran/agent-core/conversation/loop/compaction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanyueran/agent-core/conversation/loop/compaction")>();
  return { ...actual, maybeCompactHistory: vi.fn() };
});

// 存档写盘替换为 mock：只验证调用与空历史短路
vi.mock("@tanyueran/agent-core/conversation/session/session-export", () => ({
  writeSessionMarkdown: vi.fn(),
}));

const { createConversationRuntime } = await import(
  "@tanyueran/agent-core/conversation/session/runtime"
);

/** 构造测试用量 */
function makeUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/** 构造最小 LLM 配置 */
function makeLlmConfig(): LlmConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
  };
}

/** 构造假会话运行时：工具带与目录均为空，todoHandle 可观测 */
function makeRuntime(): ConversationRuntime {
  return {
    sandbox: undefined,
    assembly: {
      systemPrompt: "系统提示",
      tools: [],
      advertisedTools: [],
      catalog: { list: () => [] },
      todoHandle: { resetTodos: vi.fn() },
      bashEnabled: true,
    },
    mcpSummary: { lines: [], warnings: [] },
    bootWarnings: [],
  } as unknown as ConversationRuntime;
}

/** 构造子 Agent 装配结果：句柄与调度器均为可观测 mock */
function makeAttachResult(events: SubAgentNodeEvent[] = []) {
  return {
    handle: { setUsageReporter: vi.fn() },
    dispatcher: {
      drainEvents: vi.fn(() => events.splice(0)),
      hasRunning: vi.fn(() => false),
      waitForAll: vi.fn(async () => {}),
    },
  };
}

/** 创建测试会话：默认子 Agent 装配关闭，可按需覆盖 */
async function makeSession(options?: {
  attachResult?: ReturnType<typeof makeAttachResult>;
  thinkingLevel?: LlmConfig["thinkingLevel"];
  cliLevel?: "off" | "low" | "medium" | "high";
}) {
  vi.mocked(createConversationRuntime).mockResolvedValue(makeRuntime());
  vi.mocked(attachSubAgentIfEnabled).mockReturnValue(
    (options?.attachResult ?? {}) as unknown as ReturnType<
      typeof attachSubAgentIfEnabled
    >,
  );
  vi.mocked(maybeCompactHistory).mockResolvedValue({
    status: "skipped",
  } as never);
  const channels = createMockChannels();
  const session = await ConversationSession.create({
    llmConfig: { ...makeLlmConfig(), thinkingLevel: options?.thinkingLevel },
    modeConfig: {
      basePrompt: "基础人设",
      modeLabel: "对话模式",
      defaultThinkingLevel: "medium",
      subAgentEnabled: false,
    },
    thinkingLevel: options?.cliLevel,
    channels,
  });
  return { session, channels };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeConversationTurn).mockImplementation(async (options) => {
    options.history.push({
      type: "message",
      role: "user",
      content: options.userInput,
    });
    options.onUsage?.(makeUsage(100, 20));
    return "回答";
  });
});

describe("ConversationSession.create", () => {
  it("思考档位按 CLI > 配置 > 模式兜底解析", async () => {
    const { session: byFallback } = await makeSession();
    expect(byFallback.thinkingLevel).toBe("medium");

    const { session: byConfig } = await makeSession({ thinkingLevel: "low" });
    expect(byConfig.thinkingLevel).toBe("low");

    const { session: byCli } = await makeSession({
      thinkingLevel: "low",
      cliLevel: "high",
    });
    expect(byCli.thinkingLevel).toBe("high");
  });

  it("setThinkingLevel 切换后下一轮生效", async () => {
    const { session } = await makeSession();
    session.setThinkingLevel("off");
    expect(session.thinkingLevel).toBe("off");
  });
});

describe("ConversationSession.runTurn", () => {
  it("成功回合：用量逐轮累加，lastInputTokens 按主会话口径更新", async () => {
    const { session } = await makeSession();

    const result = await session.runTurn("第一个问题");

    expect(result.status).toBe("completed");
    expect(result.turnUsage).toEqual(makeUsage(100, 20));
    expect(session.usage.current).toEqual(makeUsage(100, 20));
    expect(session.lastInputTokens).toBe(100);
    expect(session.history).toHaveLength(1);

    await session.runTurn("第二个问题");
    expect(session.usage.current).toEqual(makeUsage(200, 40));
  });

  it("取消回合：回滚本轮历史并提示，会话可继续", async () => {
    const { session, channels } = await makeSession();
    // 先沉淀一轮历史，再取消第二轮：回滚只裁掉本轮，不回滚已完成回合
    await session.runTurn("已完成的问题");
    vi.mocked(executeConversationTurn).mockImplementation(async (options) => {
      options.history.push({
        type: "message",
        role: "user",
        content: options.userInput,
      });
      throw new CancelError("用户取消");
      return "";
    });

    const result = await session.runTurn("被取消的问题");

    expect(result.status).toBe("cancelled");
    expect(session.history).toHaveLength(1);
    expect(channels.output.texts).toContain("已取消本轮");
  });

  it("可预期业务错误：只提示不终止会话", async () => {
    const { session, channels } = await makeSession();
    vi.mocked(executeConversationTurn).mockRejectedValue(
      new CliError("接口限流"),
    );

    const result = await session.runTurn("触发限流");

    expect(result.status).toBe("failed");
    expect(channels.output.texts).toContain("接口限流");
  });

  it("未预期错误仍上抛，不被兜底吞掉", async () => {
    const { session } = await makeSession();
    vi.mocked(executeConversationTurn).mockRejectedValue(
      new TypeError("代码 bug"),
    );

    await expect(session.runTurn("触发 bug")).rejects.toThrow(TypeError);
  });

  it("回合开始收割后台事件：打印通知并注入历史（取消也不丢通知）", async () => {
    const event: SubAgentNodeEvent = {
      kind: "completed",
      nodeId: "n1",
      runId: "r1",
      preview: "调研任务",
      elapsedMs: 800,
      output: "结论全文",
    };
    const attachResult = makeAttachResult([event]);
    const { session } = await makeSession({ attachResult });

    await session.runTurn("后续问题");

    // 通知先于本轮输入注入：事件 1 条 + 用户输入 1 条
    expect(session.history).toHaveLength(2);
    expect(session.history[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(session.history[0])).toContain("[后台任务通知]");
    expect(JSON.stringify(session.history[0])).toContain("结论全文");
  });

  it("子 Agent 用量经上报器汇入本轮与累计，但不覆盖 lastInputTokens", async () => {
    const attachResult = makeAttachResult();
    const { session } = await makeSession({ attachResult });
    // 捕获回合开始时注册的上报器（回合结束会被置 undefined，故留存序列取首个）
    const reporters: Array<((usage: TokenUsage) => void) | undefined> = [];
    attachResult.handle.setUsageReporter.mockImplementation((fn) => {
      reporters.push(fn);
    });

    // 子 Agent 用量在回合进行中上报（真实路径为子 Agent 执行期间回调）
    vi.mocked(executeConversationTurn).mockImplementation(async (options) => {
      options.onUsage?.(makeUsage(100, 20));
      reporters[0]?.(makeUsage(50, 10));
      return "回答";
    });
    const result = await session.runTurn("派生任务的问题");

    expect(attachResult.handle.setUsageReporter).toHaveBeenCalled();
    expect(result.turnUsage).toEqual(makeUsage(150, 30));
    expect(session.usage.current).toEqual(makeUsage(150, 30));
    expect(session.lastInputTokens).toBe(100);
    // 回合结束撤销上报器
    expect(attachResult.handle.setUsageReporter).toHaveBeenLastCalledWith(
      undefined,
    );
  });
});

describe("ConversationSession.clear / exportSession / dispose", () => {
  it("clear 重置历史、用量与任务清单，返回清空条数", async () => {
    const { session } = await makeSession();
    await session.runTurn("问题一");

    const cleared = session.clear();

    expect(cleared).toBe(1);
    expect(session.history).toHaveLength(0);
    expect(session.lastInputTokens).toBeUndefined();
    expect(session.usage.current.totalTokens).toBe(0);
    expect(
      session.runtime.assembly.todoHandle?.resetTodos,
    ).toHaveBeenCalledTimes(1);
  });

  it("exportSession 空历史返回 undefined，非空写盘并返回路径", async () => {
    const { session } = await makeSession();
    expect(await session.exportSession()).toBeUndefined();

    await session.runTurn("问题一");
    vi.mocked(writeSessionMarkdown).mockResolvedValue("/tmp/session.md");
    expect(await session.exportSession()).toBe("/tmp/session.md");
  });

  it("dispose 幂等：运行时释放只执行一次", async () => {
    const { session } = await makeSession();

    await session.dispose();
    await session.dispose();

    expect(disposeConversationRuntime).toHaveBeenCalledTimes(1);
  });

  it("退出前有运行中后台任务时等待全部结束", async () => {
    const attachResult = makeAttachResult();
    attachResult.dispatcher.hasRunning.mockReturnValue(true);
    const { session } = await makeSession({ attachResult });

    await session.awaitBackgroundTasksOnExit();

    expect(attachResult.dispatcher.waitForAll).toHaveBeenCalledTimes(1);
  });
});
