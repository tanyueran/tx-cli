import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../src/core/conversation/common/loop";
import type { RunTurn, TurnOutcome } from "../src/core/conversation/common/loop";
import type { Tool } from "../src/core/tools";
import type { ToolCall } from "../src/types/llm";

/**
 * 构造一个用于测试的假工具，execute 直接返回预设输出
 * @param {string} name - 工具名称
 * @param {string} [output] - execute 返回的输出内容
 * @returns {Tool} 假工具实例
 */
function makeTool(name: string, output = "ok"): Tool {
  return {
    name,
    description: `${name} 工具`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true, output }),
  };
}

/**
 * 构造一个模型发起的工具调用
 * @param {string} name - 工具名称
 * @param {string} [args] - 参数的 JSON 字符串
 * @returns {ToolCall} 工具调用请求
 */
function makeCall(name: string, args = "{}"): ToolCall {
  return { id: `call_${name}`, name, arguments: args };
}

describe("runAgentLoop", () => {
  it("模型直接作答时返回回答文本", async () => {
    const runTurn = vi.fn(async (): Promise<TurnOutcome> => ({
      type: "reply",
      reply: "你好",
    }));

    const result = await runAgentLoop({ runTurn, tools: [] });

    expect(result).toBe("你好");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith([], false);
  });

  it("工具调用轮到最终回答：执行工具并回传结果，触发 onToolCall", async () => {
    const tool = makeTool("read_file", "文件内容");
    const onToolCall = vi.fn();
    let call = 0;
    const runTurn: RunTurn = async (toolResults, disableTools) => {
      call += 1;
      if (call === 1) {
        return { type: "tool_calls", toolCalls: [makeCall("read_file")] };
      }
      // 第二轮应收到上一轮工具执行结果
      expect(disableTools).toBe(false);
      expect(toolResults).toEqual([
        { callId: "call_read_file", ok: true, output: "文件内容" },
      ]);
      return { type: "reply", reply: "答案是 42" };
    };

    const result = await runAgentLoop({
      runTurn,
      tools: [tool],
      onToolCall,
    });

    expect(result).toBe("答案是 42");
    // onToolCall 附带工具实例（供调用提示自定义渲染）
    expect(onToolCall).toHaveBeenCalledWith(makeCall("read_file"), tool);
  });

  it("模型请求未注册的工具时转为失败结果回传", async () => {
    let seenResults: unknown;
    let call = 0;
    const runTurn: RunTurn = async (toolResults) => {
      call += 1;
      if (call === 1) {
        return { type: "tool_calls", toolCalls: [makeCall("ghost")] };
      }
      seenResults = toolResults;
      return { type: "reply", reply: "已纠正" };
    };

    await runAgentLoop({ runTurn, tools: [makeTool("read_file")] });

    expect(seenResults).toEqual([
      {
        callId: "call_ghost",
        ok: false,
        output: "未注册的工具: ghost，请从可用工具中选择",
      },
    ]);
  });

  it("达到 maxIterations 后进入软收敛，不再下发工具定义", async () => {
    const disableFlags: boolean[] = [];
    const runTurn: RunTurn = async (_toolResults, disableTools) => {
      disableFlags.push(disableTools);
      if (disableTools) {
        return { type: "reply", reply: "收敛作答" };
      }
      return { type: "tool_calls", toolCalls: [makeCall("read_file")] };
    };

    const result = await runAgentLoop({
      runTurn,
      tools: [makeTool("read_file")],
      maxIterations: 2,
    });

    expect(result).toBe("收敛作答");
    // 前两轮允许调用工具，第三轮起禁用
    expect(disableFlags).toEqual([false, false, true]);
  });

  it("软收敛轮模型仍请求工具时抛出 CliError", async () => {
    const runTurn: RunTurn = async (): Promise<TurnOutcome> => ({
      type: "tool_calls",
      toolCalls: [makeCall("read_file")],
    });

    await expect(
      runAgentLoop({ runTurn, tools: [makeTool("read_file")], maxIterations: 0 })
    ).rejects.toThrow("工具调用轮数已达上限");
  });

  it("首次进入软收敛轮时触发 onSoftConverge 恰好一次", async () => {
    const onSoftConverge = vi.fn();
    let call = 0;
    const runTurn: RunTurn = async (_toolResults, disableTools) => {
      call += 1;
      if (call <= 2) {
        return { type: "tool_calls", toolCalls: [makeCall("read_file")] };
      }
      expect(disableTools).toBe(true);
      return { type: "reply", reply: "收敛作答" };
    };

    const result = await runAgentLoop({
      runTurn,
      tools: [makeTool("read_file")],
      maxIterations: 2,
      onSoftConverge,
    });

    expect(result).toBe("收敛作答");
    expect(onSoftConverge).toHaveBeenCalledTimes(1);
  });

  it("未达到轮数上限时不会触发 onSoftConverge", async () => {
    const onSoftConverge = vi.fn();
    const runTurn: RunTurn = async (): Promise<TurnOutcome> => ({
      type: "reply",
      reply: "直接作答",
    });

    await runAgentLoop({
      runTurn,
      tools: [makeTool("read_file")],
      onSoftConverge,
    });

    expect(onSoftConverge).not.toHaveBeenCalled();
  });
});
