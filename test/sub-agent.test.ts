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
import { createMcpDiscoveryTool } from "../src/core/mcp/discovery-tool";
import type { Tool } from "../src/core/tools";
import type { LlmConfig, TokenUsage } from "../src/core/llm/types";

// 子 Agent 复用主会话的 streamResponse：测试中替换为可编程的假实现。
// 需同时 mock barrel 与 client 两个入口：回合函数（responses-turn）经 barrel 导入，
// 摘要生成器（llm/context）直接从 ./client 导入，只 mock barrel 会让压缩摘要请求走真实网络
const { streamResponseMock } = vi.hoisted(() => ({
  streamResponseMock: vi.fn(),
}));

vi.mock("../src/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/core/llm/client")
  >();
  return {
    ...actual,
    streamResponse: (...args: unknown[]) => streamResponseMock(...args),
  };
});

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

  it("达到压缩阈值时按工具轮次压缩子 Agent 历史", async () => {
    // 极小阈值：首轮请求的 input token 即超过阈值，第二轮工具交互完成后触发压缩
    const compactLlm: LlmConfig = {
      ...llmConfig,
      context: { maxContextTokens: 1000, compactAt: 0.5, keepRecentTurns: 1 },
    };
    const snapshots: unknown[] = [];
    const capture = (options: Record<string, unknown>): void => {
      snapshots.push(JSON.parse(JSON.stringify(options.input)));
    };
    const bigUsage: TokenUsage = { ...usage, inputTokens: 100_000, totalTokens: 100_020 };
    streamResponseMock
      .mockImplementationOnce(async (options: Record<string, unknown>) => {
        capture(options);
        return {
          reply: "",
          toolCalls: [{ callId: "call_1", name: "read_file", arguments: "{}" }],
          usage: bigUsage,
        };
      })
      .mockImplementationOnce(async (options: Record<string, unknown>) => {
        capture(options);
        return {
          reply: "",
          toolCalls: [{ callId: "call_2", name: "read_file", arguments: "{}" }],
          usage: bigUsage,
        };
      })
      // 摘要生成请求：生成器经 onDelta 累积摘要文本
      .mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.onDelta as ((text: string) => void) | undefined)?.(
          "此前已读取配置文件并确认字段结构",
        );
        return { reply: "", toolCalls: [], usage };
      })
      .mockImplementationOnce(async (options: Record<string, unknown>) => {
        capture(options);
        return { reply: "结论", toolCalls: [], usage };
      });

    const runner = createSubAgentRunner({
      llmConfig: compactLlm,
      tools: [makeTool("read_file")],
    });
    const result = await runner({ task: "读取配置" });

    expect(result.output).toBe("结论");
    // 两次工具请求 + 一次摘要请求 + 一次最终请求
    expect(streamResponseMock).toHaveBeenCalledTimes(4);
    // 压缩后的最终请求：任务消息与摘要在前，最近一轮工具交互保持原文（配对完整）
    const input = snapshots[2] as Array<Record<string, unknown>>;
    expect(input).toHaveLength(4);
    expect(input[0]).toMatchObject({ role: "user", content: "子任务：读取配置" });
    expect(JSON.stringify(input[1])).toContain("此前对话已压缩为以下摘要");
    expect(input[2]).toMatchObject({ type: "function_call", callId: "call_2" });
    expect(input[3]).toMatchObject({
      type: "function_call_output",
      callId: "call_2",
    });
  });

  it("子 Agent 达到轮数上限进入软收敛时输出提示，且软收敛轮不下发工具定义", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      streamResponseMock
        .mockResolvedValueOnce({
          reply: "",
          toolCalls: [{ callId: "call_1", name: "read_file", arguments: "{}" }],
          usage,
        })
        .mockResolvedValueOnce({ reply: "结论", toolCalls: [], usage });
      const runner = createSubAgentRunner({
        llmConfig,
        tools: [makeTool("read_file")],
        maxIterations: 1,
      });

      const result = await runner({ task: "任务" });

      expect(result.output).toBe("结论");
      const softLog = logSpy.mock.calls.find((args) =>
        String(args[0]).includes("轮上限"),
      );
      expect(softLog).toBeDefined();
      // 软收敛轮不下发工具定义，迫使模型基于已有信息作答
      expect(callArg(1).tools).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("attachSubAgentTools", () => {
  it("原地追加 delegate_task 到全量与下发列表，保持与 MCP 激活机制共享引用", () => {
    const mainTools = [makeTool("read_file"), makeTool("write_todos")];
    const mainAdvertised = [makeTool("read_file")];

    const attached = attachSubAgentTools({
      llmConfig,
      tools: mainTools,
      advertisedTools: mainAdvertised,
    });

    // 原地追加：返回原数组引用（discover_mcp_tools 的激活依赖与请求层共享同一数组）
    expect(attached.tools).toBe(mainTools);
    expect(attached.advertisedTools).toBe(mainAdvertised);
    expect(mainTools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_todos",
      SUB_AGENT_TOOL_NAME,
    ]);
    expect(mainAdvertised.map((tool) => tool.name)).toEqual([
      "read_file",
      SUB_AGENT_TOOL_NAME,
    ]);
    expect(attached.handle.tool.name).toBe(SUB_AGENT_TOOL_NAME);
  });

  it("MCP 折叠模式下激活的工具写入会话下发列表（请求层可见）", async () => {
    // 构造折叠场景：下发列表只含 discover_mcp_tools，执行侧持有全部 MCP 工具
    const pool = Array.from({ length: 3 }, (_, i) =>
      makeTool(`mcp__srv__tool${i}`),
    );
    const advertised: Tool[] = [makeTool("read_file")];
    advertised.push(createMcpDiscoveryTool(pool, advertised));
    const tools = [...advertised, ...pool];

    const attached = attachSubAgentTools({
      llmConfig,
      tools,
      advertisedTools: advertised,
    });
    expect(attached.advertisedTools).toBe(advertised);

    const discovery = advertised.find(
      (tool) => tool.name === "discover_mcp_tools",
    );
    expect(discovery?.execute).toBeDefined();
    if (!discovery?.execute) {
      return;
    }

    const result = await discovery.execute({ activate: ["mcp__srv__tool1"] });
    expect(result.ok).toBe(true);
    // 激活的工具进入会话下发列表（同一数组引用），下一轮请求即可携带其定义
    expect(advertised.some((tool) => tool.name === "mcp__srv__tool1")).toBe(
      true,
    );
  });

  it("MCP 折叠模式下子 Agent 使用重绑的 discovery，激活只写入自己的下发列表", async () => {
    const pool = Array.from({ length: 3 }, (_, i) =>
      makeTool(`mcp__srv__tool${i}`),
    );
    const advertised: Tool[] = [makeTool("read_file")];
    advertised.push(createMcpDiscoveryTool(pool, advertised));
    const tools = [...advertised, ...pool];

    const attached = attachSubAgentTools({
      llmConfig,
      tools,
      advertisedTools: advertised,
    });

    // 子 Agent 首次请求的工具清单应含重绑的 discovery 实例（非主会话实例）
    streamResponseMock.mockResolvedValue({ reply: "ok", toolCalls: [], usage });
    await attached.handle.tool.execute({ task: "调用 MCP 工具" });
    const firstCallTools = (callArg(0).tools as Tool[]) ?? [];
    const subDiscovery = firstCallTools.find(
      (tool) => tool.name === "discover_mcp_tools",
    );
    expect(subDiscovery).toBeDefined();
    expect(subDiscovery).not.toBe(
      advertised.find((tool) => tool.name === "discover_mcp_tools"),
    );
    if (!subDiscovery?.execute) {
      return;
    }

    // 子 Agent 内激活：写入子 Agent 自己的下发列表，主会话列表不受影响
    await subDiscovery.execute({ activate: ["mcp__srv__tool2"] });
    streamResponseMock.mockClear();
    streamResponseMock.mockResolvedValue({ reply: "ok", toolCalls: [], usage });
    await attached.handle.tool.execute({ task: "再次派生" });
    const secondCallTools = (callArg(0).tools as Tool[]) ?? [];
    expect(
      secondCallTools.some((tool) => tool.name === "mcp__srv__tool2"),
    ).toBe(true);
    expect(advertised.some((tool) => tool.name === "mcp__srv__tool2")).toBe(
      false,
    );
  });
});
