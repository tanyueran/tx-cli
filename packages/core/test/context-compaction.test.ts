import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSummaryTranscript,
  createSummaryMessage,
  estimateHistoryTokens,
  findCompactionSplit,
  generateSummary,
  resolveCompactionConfig,
  shouldCompact,
  SUMMARY_MARKER,
} from "@tx-cli/core/llm/context";
import {
  formatCompactionNotice,
  maybeCompactHistory,
} from "@tx-cli/core/conversation/loop/compaction";
import { loadLlmConfig } from "@tx-cli/core/llm/config";
import type {
  LlmConfig,
  ResponseHistoryItem,
  TokenUsage,
} from "@tx-cli/core/llm/types";

/**
 * 构造一轮完整对话：用户提问 → 工具调用与结果 → 助手回答
 * @param {number} index - 轮次序号
 * @returns {ResponseHistoryItem[]} 该轮历史项
 */
function makeRound(index: number): ResponseHistoryItem[] {
  return [
    { type: "message", role: "user", content: `问题${index}` },
    {
      type: "function_call",
      callId: `call-${index}`,
      name: "read_file",
      arguments: `{"path":"file-${index}.ts"}`,
    },
    {
      type: "function_call_output",
      callId: `call-${index}`,
      output: `内容${index}`,
    },
    { type: "message", role: "assistant", content: `回答${index}` },
  ];
}

/**
 * 构造多轮历史
 * @param {number} rounds - 轮数
 * @returns {ResponseHistoryItem[]} 历史项
 */
function makeHistory(rounds: number): ResponseHistoryItem[] {
  return Array.from({ length: rounds }, (_item, index) => makeRound(index)).flat();
}

/**
 * 构造测试用 LLM 配置
 * @param {object} [context] - 上下文压缩配置
 * @returns {LlmConfig} 接入配置
 */
function makeConfig(context?: LlmConfig["context"]): LlmConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    context,
  };
}

/**
 * 构造用量
 * @param {number} inputTokens - 输入 token
 * @param {number} outputTokens - 输出 token
 * @returns {TokenUsage} 用量
 */
function makeUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

describe("resolveCompactionConfig", () => {
  it("未配置 maxContextTokens 时不启用压缩", () => {
    expect(resolveCompactionConfig(undefined)).toBeUndefined();
    expect(resolveCompactionConfig({})).toBeUndefined();
    expect(resolveCompactionConfig({ compactAt: 0.5 })).toBeUndefined();
    expect(resolveCompactionConfig({ maxContextTokens: 0 })).toBeUndefined();
    expect(resolveCompactionConfig({ maxContextTokens: -1 })).toBeUndefined();
  });

  it("按缺省比例与轮数补齐配置", () => {
    const config = resolveCompactionConfig({ maxContextTokens: 10_000 });

    expect(config).toEqual({
      maxContextTokens: 10_000,
      thresholdTokens: 7_000,
      keepRecentTurns: 4,
      summaryMaxChars: 2_000,
    });
  });

  it("compactAt 大于 1 时按绝对 token 数处理，并钳制在窗口内", () => {
    expect(
      resolveCompactionConfig({ maxContextTokens: 10_000, compactAt: 8_000 })
        ?.thresholdTokens,
    ).toBe(8_000);
    expect(
      resolveCompactionConfig({ maxContextTokens: 10_000, compactAt: 20_000 })
        ?.thresholdTokens,
    ).toBe(10_000);
  });

  it("轮数与摘要长度取下限，避免无效压缩", () => {
    const config = resolveCompactionConfig({
      maxContextTokens: 10_000,
      keepRecentTurns: 0.5,
      summaryMaxChars: 100,
    });

    expect(config?.keepRecentTurns).toBe(4);
    expect(config?.summaryMaxChars).toBe(200);
  });
});

describe("estimateHistoryTokens", () => {
  it("空历史估算为 0", () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });

  it("消息、工具参数与工具结果全部计入并按每 2 字符 1 token 估算", () => {
    const history: ResponseHistoryItem[] = [
      { type: "message", role: "user", content: "a".repeat(100) },
      { type: "function_call", callId: "c", name: "grep", arguments: "b".repeat(50) },
      { type: "function_call_output", callId: "c", output: "c".repeat(50) },
    ];

    // 100 + (50 + 4) + 50 = 204 字符 → 102 token
    expect(estimateHistoryTokens(history)).toBe(102);
  });
});

describe("shouldCompact", () => {
  const config = resolveCompactionConfig({ maxContextTokens: 10_000 })!;

  it("优先使用上一轮真实 input token", () => {
    expect(shouldCompact([], config, 8_000)).toBe(true);
    expect(shouldCompact([], config, 6_999)).toBe(false);
  });

  it("无 usage 时回退字符估算", () => {
    const longHistory: ResponseHistoryItem[] = [
      { type: "message", role: "user", content: "a".repeat(14_000) },
    ];

    expect(shouldCompact(longHistory, config)).toBe(true);
    expect(shouldCompact([], config)).toBe(false);
  });
});

describe("findCompactionSplit", () => {
  it("切分点落在用户提问上，保留最近 N 轮", () => {
    const history = makeHistory(4);
    const split = findCompactionSplit(history, 2);

    expect(split).toBe(8);
    expect(history[split]).toMatchObject({ type: "message", role: "user" });
  });

  it("轮次不足时返回 0（不压缩）", () => {
    const history = makeHistory(2);

    expect(findCompactionSplit(history, 2)).toBe(0);
    expect(findCompactionSplit(makeHistory(3), 4)).toBe(0);
  });

  it("保留至少 1 轮，避免把整段历史摘要掉", () => {
    const history = makeHistory(3);

    expect(findCompactionSplit(history, 0)).toBe(8);
    expect(findCompactionSplit(history, 1)).toBe(8);
  });

  it("切分后不切断 function_call 与 function_call_output 配对", () => {
    const history = makeHistory(2);
    history.push({ type: "message", role: "user", content: "问题2" });
    const split = findCompactionSplit(history, 2);

    // 保留片段从用户提问开始，工具调用与结果数量一致（配对完整）
    const kept = history.slice(split);
    expect(kept[0]).toMatchObject({ type: "message", role: "user" });
    expect(kept.filter((item) => item.type === "function_call")).toHaveLength(1);
    expect(
      kept.filter((item) => item.type === "function_call_output"),
    ).toHaveLength(1);
  });
});

describe("buildSummaryTranscript", () => {
  it("按角色与工具调用展开历史", () => {
    const transcript = buildSummaryTranscript(makeRound(1));

    expect(transcript).toContain("用户：问题1");
    expect(transcript).toContain('工具调用 read_file({"path":"file-1.ts"})');
    expect(transcript).toContain("工具结果：内容1");
    expect(transcript).toContain("助手：回答1");
  });

  it("超长工具输出截断并标注原长度", () => {
    const output = "x".repeat(1_500);
    const transcript = buildSummaryTranscript([
      { type: "function_call_output", callId: "c", output },
    ]);

    expect(transcript).toContain("已截断，原长度 1500 字符");
    expect(transcript).not.toContain(output);
  });
});

describe("createSummaryMessage", () => {
  it("以 user 角色放在历史首部并带标记", () => {
    const message = createSummaryMessage("用户想重构认证模块", 2_000);

    expect(message).toMatchObject({ type: "message", role: "user" });
    expect(message.type === "message" ? message.content : "").toContain(
      SUMMARY_MARKER,
    );
    expect(message.type === "message" ? message.content : "").toContain(
      "用户想重构认证模块",
    );
  });

  it("摘要超过长度上限时截断", () => {
    const message = createSummaryMessage("a".repeat(500), 200);
    const content = message.type === "message" ? message.content : "";

    expect(content).toContain("已截断，原长度 500 字符");
    expect(content).not.toContain("a".repeat(210));
  });
});

describe("generateSummary", () => {
  it("摘要为空视为失败", async () => {
    await expect(
      generateSummary("素材", async () => ({ summary: "   " }), 2_000),
    ).rejects.toThrow("摘要生成为空");
  });

  it("返回截断后的摘要与原用量", async () => {
    const usage = makeUsage(100, 50);
    const result = await generateSummary(
      "素材",
      async () => ({ summary: "摘".repeat(300), usage }),
      200,
    );

    expect(result.usage).toEqual(usage);
    expect(result.summary).toContain("已截断，原长度 300 字符");
  });
});

describe("maybeCompactHistory", () => {
  it("未配置压缩时直接跳过", async () => {
    const outcome = await maybeCompactHistory({
      llmConfig: makeConfig(),
      history: makeHistory(5),
      summaryGenerator: async () => ({ summary: "摘要" }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("未达阈值时不发起摘要请求", async () => {
    const generator = vi.fn(async () => ({ summary: "摘要" }));
    const outcome = await maybeCompactHistory({
      llmConfig: makeConfig({ maxContextTokens: 100_000 }),
      history: makeHistory(5),
      lastInputTokens: 10_000,
      summaryGenerator: generator,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "below-threshold" });
    expect(generator).not.toHaveBeenCalled();
  });

  it("可压缩轮次不足时跳过并保留历史", async () => {
    const history = makeHistory(2);
    const outcome = await maybeCompactHistory({
      llmConfig: makeConfig({ maxContextTokens: 1 }),
      history,
      summaryGenerator: async () => ({ summary: "摘要" }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not-enough-turns" });
    expect(history).toEqual(makeHistory(2));
  });

  it("达阈值时原地替换早期历史并上报摘要用量", async () => {
    const history = makeHistory(5);
    const usage = makeUsage(300, 80);
    const onUsage = vi.fn();
    const outcome = await maybeCompactHistory({
      llmConfig: makeConfig({ maxContextTokens: 1, keepRecentTurns: 2 }),
      history,
      summaryGenerator: async () => ({ summary: "早前在排查认证问题", usage }),
      onUsage,
    });

    expect(outcome).toMatchObject({
      status: "compacted",
      beforeMessages: 20,
      afterMessages: 9,
      compactedMessages: 12,
    });
    // 历史数组引用保持不变，首项为摘要消息，最近 2 轮原文保留
    expect(history).toHaveLength(9);
    expect(history[0]).toMatchObject({ type: "message", role: "user" });
    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(history[8]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "回答4",
    });
  });

  it("摘要失败时保持原历史并返回失败原因", async () => {
    const history = makeHistory(5);
    const outcome = await maybeCompactHistory({
      llmConfig: makeConfig({ maxContextTokens: 1, keepRecentTurns: 2 }),
      history,
      summaryGenerator: async () => {
        throw new Error("网络超时");
      },
    });

    expect(outcome).toEqual({
      status: "failed",
      message: "网络超时",
    });
    expect(history).toEqual(makeHistory(5));
  });
});

describe("formatCompactionNotice", () => {
  it("已压缩时给出前后条数与摘要长度", () => {
    expect(
      formatCompactionNotice({
        status: "compacted",
        beforeMessages: 20,
        afterMessages: 9,
        compactedMessages: 12,
        summaryChars: 800,
      }),
    ).toBe(
      "已压缩上下文：早期 12 条消息 → 1 条摘要（800 字），当前历史 9 条",
    );
  });

  it("失败时说明继续使用完整历史，跳过时不输出", () => {
    expect(formatCompactionNotice({ status: "failed", message: "网络超时" })).toBe(
      "上下文压缩失败：网络超时（本轮继续使用完整历史）",
    );
    expect(
      formatCompactionNotice({ status: "skipped", reason: "disabled" }),
    ).toBeUndefined();
  });
});

describe("llm.context 配置加载", () => {
  /** 配置临时目录 */
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tx-cli-context-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("项目配置逐字段覆盖全局，非法字段被忽略", async () => {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        llm: {
          apiKey: "sk",
          baseUrl: "https://example.com/v1",
          model: "m",
          context: { maxContextTokens: 128_000, keepRecentTurns: 6 },
        },
      }),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        llm: { context: { keepRecentTurns: 2, compactAt: -1 } },
      }),
    );

    const config = await loadLlmConfig(globalPath, projectPath);

    expect(config.context).toEqual({
      maxContextTokens: 128_000,
      keepRecentTurns: 2,
    });
  });

  it("未配置 context 时保持 undefined", async () => {
    const globalPath = join(dir, "global.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        llm: { apiKey: "sk", baseUrl: "https://example.com/v1", model: "m" },
      }),
    );

    const config = await loadLlmConfig(globalPath, join(dir, "none.json"));

    expect(config.context).toBeUndefined();
  });
});
