import { describe, it, expect, vi, beforeEach } from "vitest";
import { CancelError, CliError } from "../src/shared/errors";
import {
  attachSubAgentTools,
  createSubAgentRunner,
  createSubAgentTool,
  filterSubAgentTools,
  SUB_AGENT_TOOL_NAME,
} from "../src/core/conversation/common/turn/sub-agent";
import type { SubAgentRunner } from "../src/core/conversation/common/turn/sub-agent";
import type { Tool } from "../src/core/tools";
import type { LlmConfig, TokenUsage } from "../src/core/llm/types";

// 子 Agent 复用主会话的 streamResponse：测试中替换为可编程的假实现
const { streamResponseMock } = vi.hoisted(() => ({
  streamResponseMock: vi.fn(),
}));

vi.mock("../src/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/llm")>();
  return {
    ...actual,
    streamResponse: (...args: unknown[]) => streamResponseMock(...args),
  };
});

/** 测试用 LLM 配置（仅保留必填字段） */
const llmConfig: LlmConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
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

/**
 * 读取假 streamResponse 第 N 次调用的入参
 * @param {number} index - 调用序号（从 0 起）
 * @returns {Record<string, unknown>} 调用入参对象
 */
function callArg(index: number): Record<string, unknown> {
  return streamResponseMock.mock.calls[index][0] as Record<string, unknown>;
}

beforeEach(() => {
  streamResponseMock.mockReset();
});

describe("createSubAgentTool", () => {
  it("缺少 task 参数时返回失败说明", async () => {
    const handle = createSubAgentTool(vi.fn());
    const result = await handle.tool.execute({});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("缺少 task 参数");
  });

  it("task 超过字符上限时拒绝执行", async () => {
    const handle = createSubAgentTool(vi.fn());
    const result = await handle.tool.execute({ task: "x".repeat(4001) });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("task 过长");
  });

  it("context 非字符串时返回失败说明", async () => {
    const handle = createSubAgentTool(vi.fn());
    const result = await handle.tool.execute({ task: "分析项目", context: 1 });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("context 参数必须为字符串");
  });

  it("成功时回传子 Agent 结论，并经上报器转交用量", async () => {
    const onUsage = vi.fn();
    const runner: SubAgentRunner = vi.fn(async (_request, report) => {
      report?.(usage);
      return { output: "已完成分析：共 3 个模块" };
    });
    const handle = createSubAgentTool(runner);
    handle.setUsageReporter(onUsage);

    const result = await handle.tool.execute({
      task: "统计模块数量",
      context: "只看 src 目录",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("子 Agent 结论");
    expect(result.output).toContain("共 3 个模块");
    expect(runner).toHaveBeenCalledWith(
      { task: "统计模块数量", context: "只看 src 目录" },
      expect.any(Function),
    );
    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it("未设置上报器时 runner 收到 undefined，用量不上报", async () => {
    let receivedReporter: unknown = "unset";
    const runner: SubAgentRunner = async (_request, report) => {
      receivedReporter = report;
      return { output: "结论" };
    };
    const handle = createSubAgentTool(runner);

    await handle.tool.execute({ task: "子任务" });

    expect(receivedReporter).toBeUndefined();
  });

  it("清除上报器后不再上报用量", async () => {
    const onUsage = vi.fn();
    const runner: SubAgentRunner = vi.fn(async (_request, report) => {
      report?.(usage);
      return { output: "结论" };
    });
    const handle = createSubAgentTool(runner);
    handle.setUsageReporter(onUsage);
    handle.setUsageReporter(undefined);

    await handle.tool.execute({ task: "子任务" });

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("子 Agent 执行失败转为失败输出，不抛出", async () => {
    const runner = vi.fn(async () => {
      throw new CliError("接口请求失败");
    });
    const handle = createSubAgentTool(runner);

    const result = await handle.tool.execute({ task: "子任务" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("接口请求失败");
  });

  it("用户取消原样上抛，交由回合取消流程处理", async () => {
    const runner = vi.fn(async () => {
      throw new CancelError();
    });
    const handle = createSubAgentTool(runner);

    await expect(handle.tool.execute({ task: "子任务" })).rejects.toThrow(
      CancelError,
    );
  });

  it("调用提示展示子任务预览并截断过长描述", () => {
    const handle = createSubAgentTool(vi.fn());
    const renderCall = handle.tool.renderCall;
    expect(renderCall).toBeDefined();
    if (!renderCall) {
      return;
    }

    expect(renderCall({})).toContain("缺少 task 参数");
    expect(renderCall({ task: "分析 package.json" })).toBe(
      "子任务：分析 package.json",
    );
    expect(renderCall({ task: "x".repeat(200) })).toContain("…");
  });

  it("声明工作者超时，避免子任务被默认 30s 截断", () => {
    const handle = createSubAgentTool(vi.fn());
    expect(handle.tool.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe("filterSubAgentTools", () => {
  it("剔除共享任务清单与 delegate_task 自身", () => {
    const tools = [
      makeTool("read_file"),
      makeTool("write_todos"),
      makeTool(SUB_AGENT_TOOL_NAME),
    ];

    const filtered = filterSubAgentTools(tools);

    expect(filtered.map((tool) => tool.name)).toEqual(["read_file"]);
  });
});

describe("createSubAgentRunner", () => {
  it("每次派生使用独立历史，任务与背景写入首条用户消息", async () => {
    // 历史数组按引用传给 streamResponse 且随后会被继续追加：调用当场做快照
    const snapshots: unknown[] = [];
    streamResponseMock.mockImplementation(
      async (options: Record<string, unknown>) => {
        snapshots.push(JSON.parse(JSON.stringify(options.input)));
        return { reply: "  结论  ", toolCalls: [], usage };
      },
    );
    const onUsage = vi.fn();
    const runner = createSubAgentRunner({
      llmConfig,
      tools: [makeTool("read_file")],
      skills: [{ name: "demo", description: "示例技能" }],
      extraBody: () => ({ reasoning: { effort: "low" } }),
    });

    const first = await runner(
      { task: "分析 src 目录", context: "只读操作" },
      onUsage,
    );
    await runner({ task: "分析 test 目录" });

    expect(first.output).toBe("结论");
    expect(onUsage).toHaveBeenCalledWith(usage);
    // 子 Agent 的提示词带独立人设与技能清单
    expect(callArg(0).instructions).toContain("你是 tx-cli 的子 Agent");
    expect(callArg(0).instructions).toContain("- demo: 示例技能");
    // 首次请求只有一条用户消息，任务与背景都在其中
    expect(snapshots[0]).toEqual([
      {
        type: "message",
        role: "user",
        content: "子任务：分析 src 目录\n\n背景信息：\n只读操作",
      },
    ]);
    expect(callArg(0).extraBody).toEqual({ reasoning: { effort: "low" } });
    // 第二次派生重新开始，没有上一轮残留（独立上下文的关键）
    expect(snapshots[1]).toEqual([
      {
        type: "message",
        role: "user",
        content: "子任务：分析 test 目录",
      },
    ]);
  });

  it("子 Agent 内部工具调用正常往返，历史中保留配对项", async () => {
    const snapshots: unknown[] = [];
    const capture = (options: Record<string, unknown>, response: unknown) => {
      snapshots.push(JSON.parse(JSON.stringify(options.input)));
      return response;
    };
    streamResponseMock
      .mockImplementationOnce(async (options: Record<string, unknown>) =>
        capture(options, {
          reply: "",
          toolCalls: [{ callId: "call_1", name: "read_file", arguments: "{}" }],
          usage,
        }),
      )
      .mockImplementationOnce(async (options: Record<string, unknown>) =>
        capture(options, { reply: "结论", toolCalls: [], usage }),
      );
    let executed = 0;
    const readFileTool: Tool = {
      name: "read_file",
      description: "读文件",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed += 1;
        return { ok: true, output: "文件内容" };
      },
    };
    const runner = createSubAgentRunner({
      llmConfig,
      tools: [readFileTool],
    });

    const result = await runner({ task: "读一下配置" });

    expect(executed).toBe(1);
    expect(result.output).toBe("结论");
    // 第二次请求携带工具调用与结果，且首条用户消息仍是本次子任务
    const input = snapshots[1] as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[1]).toMatchObject({ type: "function_call", callId: "call_1" });
    expect(input[2]).toMatchObject({
      type: "function_call_output",
      callId: "call_1",
      output: "文件内容",
    });
  });

  it("子 Agent 未给出文字结论时回传兜底说明", async () => {
    streamResponseMock.mockResolvedValue({ reply: "   ", toolCalls: [], usage });
    const runner = createSubAgentRunner({ llmConfig, tools: [] });

    const result = await runner({ task: "空结论" });

    expect(result.output).toContain("未给出文字结论");
  });
});

describe("attachSubAgentTools", () => {
  it("追加 delegate_task 到全量与下发列表，且不改动原数组", () => {
    const mainTools = [makeTool("read_file"), makeTool("write_todos")];
    const mainAdvertised = [makeTool("read_file")];

    const attached = attachSubAgentTools({
      llmConfig,
      tools: mainTools,
      advertisedTools: mainAdvertised,
    });

    expect(mainTools.map((tool) => tool.name)).toEqual(["read_file", "write_todos"]);
    expect(attached.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_todos",
      SUB_AGENT_TOOL_NAME,
    ]);
    expect(attached.advertisedTools.map((tool) => tool.name)).toEqual([
      "read_file",
      SUB_AGENT_TOOL_NAME,
    ]);
    expect(attached.handle.tool.name).toBe(SUB_AGENT_TOOL_NAME);
  });
});
