import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../src/core/conversation/common/loop";
import type { RunTurn, TurnOutcome } from "../src/core/conversation/common/loop";
import type { Tool } from "../src/core/tools";
import type { ToolCall } from "../src/core/llm/types";
import { CancelError } from "../src/shared/errors";
import { markTurnCancelled } from "../src/shared/turn-cancel";
import { wrapToolWithPermission } from "../src/core/tools/permission";
import { SerialQueue } from "../src/core/sandbox/runtime/serial-queue";
import type { SandboxContext } from "../src/core/sandbox/runtime/context";

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
  return { callId: `call_${name}`, name, arguments: args };
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
    const runTurn: RunTurn = async (toolResults, toolsDisabled) => {
      call += 1;
      if (call === 1) {
        return { type: "tool_calls", toolCalls: [makeCall("read_file")] };
      }
      // 第二轮应收到上一轮工具执行结果
      expect(toolsDisabled).toBe(false);
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
    const runTurn: RunTurn = async (_toolResults, toolsDisabled) => {
      disableFlags.push(toolsDisabled);
      if (toolsDisabled) {
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
    const runTurn: RunTurn = async (_toolResults, toolsDisabled) => {
      call += 1;
      if (call <= 2) {
        return { type: "tool_calls", toolCalls: [makeCall("read_file")] };
      }
      expect(toolsDisabled).toBe(true);
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

  it("同轮串行工具被取消后，排队中的剩余工具不再执行", async () => {
    // 真实串行队列 + 门卫包装（guard 放行），复现「取消后同轮剩余工具照常执行」场景
    const queue = new SerialQueue();
    const sandbox = {
      runSerial: <T,>(task: () => Promise<T>) => queue.run(task),
      guard: async () => null,
    } as unknown as SandboxContext;

    let tool2Executed = false;
    const makeSerialTool = (
      id: string,
      execute: Tool["execute"],
    ): Tool => ({
      // toolMap 按工具名建索引，同轮多个工具需不同名称
      name: `bash_${id}`,
      description: `串行工具 ${id}`,
      parameters: { type: "object", properties: {} },
      permission: {
        capabilities: [],
        ruleKey: () => `bash(${id})`,
        isSerial: true,
      },
      execute,
    });
    const tool1 = makeSerialTool("a", async () => {
      // 模拟真实 onCancel 语义：同步标记回合取消（早于一切 Promise 传播）后抛出
      markTurnCancelled();
      throw new CancelError();
    });
    const tool2 = makeSerialTool("b", async () => {
      tool2Executed = true;
      return { ok: true, output: "不应执行" };
    });

    const runTurn: RunTurn = async (): Promise<TurnOutcome> => ({
      type: "tool_calls",
      toolCalls: [makeCall("bash_a", '"a"'), makeCall("bash_b", '"b"')],
    });

    await expect(
      runAgentLoop({
        runTurn,
        tools: [
          wrapToolWithPermission(tool1, sandbox),
          wrapToolWithPermission(tool2, sandbox),
        ],
      }),
    ).rejects.toThrow(CancelError);

    // 等待串行队列轮转到工具 2：取消标记已置位，启动点拦截使其不执行
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tool2Executed).toBe(false);
  });

  it("未发生取消时同轮串行工具正常依次执行", async () => {
    const queue = new SerialQueue();
    const sandbox = {
      runSerial: <T,>(task: () => Promise<T>) => queue.run(task),
      guard: async () => null,
    } as unknown as SandboxContext;
    const executed: string[] = [];
    const makeSerialTool = (id: string): Tool => ({
      // toolMap 按工具名建索引，同轮多个工具需不同名称
      name: `bash_${id}`,
      description: `串行工具 ${id}`,
      parameters: { type: "object", properties: {} },
      permission: {
        capabilities: [],
        ruleKey: () => `bash(${id})`,
        isSerial: true,
      },
      execute: async () => {
        executed.push(id);
        return { ok: true, output: id };
      },
    });

    const runTurn: RunTurn = async (toolResults) => {
      if (toolResults.length === 0) {
        return {
          type: "tool_calls",
          toolCalls: [makeCall("bash_a", '"a"'), makeCall("bash_b", '"b"')],
        };
      }
      return { type: "reply", reply: "完成" };
    };

    const result = await runAgentLoop({
      runTurn,
      tools: [
        wrapToolWithPermission(makeSerialTool("a"), sandbox),
        wrapToolWithPermission(makeSerialTool("b"), sandbox),
      ],
    });

    expect(result).toBe("完成");
    expect(executed).toEqual(["a", "b"]);
  });
});
