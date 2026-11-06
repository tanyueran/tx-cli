/**
 * 压缩用量的口径隔离回归测试
 * 契约：压缩摘要请求的 token 用量只流入「统计回调」（execute-turn 的 onCompactionUsage /
 * 子 Agent 执行核的派生级 onUsage），绝不流入会更新 lastInputTokens 的「真实请求回调」——
 * 摘要的 inputTokens ≈ 被压缩段原大小（仍超阈值），回流会让后续压缩判定误判而重复压缩
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeConversationTurn } from "@tx-cli/core/conversation/loop/execute-turn";
import { createSubAgentRunner } from "@tx-cli/core/conversation/sub-agent/attach";
import type { SubAgentRunner } from "@tx-cli/core/conversation/sub-agent/attach";
import type { Tool } from "@tx-cli/core/tools";
import type { LlmConfig, TokenUsage } from "@tx-cli/core/llm/types";

// 子 Agent 与主会话复用同一 streamResponse；同时 mock barrel 与 client 两个入口
// （回合函数经 barrel 导入，摘要生成器从 ./client 导入）。
// 压缩判定用 spy 包装：保留 maybeCompactHistory 其余导出原实现，仅拦截以断言接线契约
const { streamResponseMock, maybeCompactHistoryMock } = vi.hoisted(() => ({
  streamResponseMock: vi.fn(),
  maybeCompactHistoryMock: vi.fn(),
}));

vi.mock("@tx-cli/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@tx-cli/core/llm/client")
  >();
  return {
    ...actual,
    streamResponse: (...args: unknown[]) => streamResponseMock(...args),
  };
});

vi.mock("@tx-cli/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tx-cli/core/llm")>();
  return {
    ...actual,
    streamResponse: (...args: unknown[]) => streamResponseMock(...args),
  };
});

vi.mock("@tx-cli/core/conversation/loop/compaction", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@tx-cli/core/conversation/loop/compaction")
  >();
  return {
    ...actual,
    maybeCompactHistory: (...args: unknown[]) =>
      maybeCompactHistoryMock(...args),
  };
});

/** 启用压缩的测试用 LLM 配置（阈值 500：首轮 100+20 即触发） */
const compactLlm: LlmConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
  context: { maxContextTokens: 1000, compactAt: 0.5, keepRecentTurns: 1 },
};

/** 测试用 token 用量 */
const usage: TokenUsage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cachedTokens: 0,
  reasoningTokens: 0,
};

/**
 * 构造一个用于测试的假工具
 * @param {string} name - 工具名称
 * @returns {Tool} 假工具实例
 */
function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} 工具`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true, output: `${name} 结果` }),
  };
}

beforeEach(() => {
  streamResponseMock.mockReset();
  maybeCompactHistoryMock.mockReset();
  // 压缩判定默认跳过：只验证接线，不触发真实摘要流程
  maybeCompactHistoryMock.mockResolvedValue({
    status: "skipped",
    reason: "below-threshold",
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("压缩用量的口径隔离", () => {
  it("回合内压缩：摘要请求用量只流入 onCompactionUsage，不流入 onUsage", async () => {
    streamResponseMock
      .mockResolvedValueOnce({
        reply: "",
        toolCalls: [{ callId: "call_1", name: "noop", arguments: "{}" }],
        usage,
      })
      .mockResolvedValueOnce({ reply: "完成", toolCalls: [], usage });
    const onUsage = vi.fn();
    const onCompactionUsage = vi.fn();

    await executeConversationTurn({
      llmConfig: compactLlm,
      thinkingLevel: "off",
      thinkingStyle: "none",
      history: [],
      userInput: "做点事",
      instructions: "sys",
      tools: [makeTool("noop")],
      advertisedTools: [makeTool("noop")],
      onUsage,
      onCompactionUsage,
    });

    // 压缩判定发生在第二次请求前（iteration=1 的安全点）
    expect(maybeCompactHistoryMock).toHaveBeenCalledTimes(1);
    const compactionArg = maybeCompactHistoryMock.mock.calls[0][0] as {
      onUsage?: unknown;
    };
    // 契约：摘要用量流向独立的统计回调，而非「真实请求口径」的 onUsage
    expect(compactionArg.onUsage).toBe(onCompactionUsage);
    expect(compactionArg.onUsage).not.toBe(onUsage);
  });

  it("子 Agent 压缩：摘要请求用量流入派生级 onUsage（统计），而非包装 lastInputTokens 的回调", async () => {
    streamResponseMock
      .mockResolvedValueOnce({
        reply: "",
        toolCalls: [{ callId: "call_1", name: "noop", arguments: "{}" }],
        usage,
      })
      .mockResolvedValueOnce({ reply: "结论", toolCalls: [], usage });
    const reporter = vi.fn();
    const runner: SubAgentRunner = createSubAgentRunner({
      llmConfig: compactLlm,
      tools: [makeTool("noop")],
    });

    const result = await runner({ task: "子任务" }, reporter);

    expect(result.output).toBe("结论");
    expect(maybeCompactHistoryMock).toHaveBeenCalledTimes(1);
    const compactionArg = maybeCompactHistoryMock.mock.calls[0][0] as {
      onUsage?: unknown;
    };
    // 契约：摘要用量流向派生级 reporter（计入会话统计），
    // 若流入的是同时更新 lastInputTokens 的包装回调，此断言会失败
    expect(compactionArg.onUsage).toBe(reporter);
  });
});
