import { describe, it, expect, vi, afterEach } from "vitest";
import { executeToolCall } from "../src/core/tools/executor";
import type { Tool, ToolOutput } from "../src/core/tools";
import type { ToolCall } from "../src/core/llm/types";

/** 工具输出回传前的截断上限（字符数），与 executor 内部常量保持一致 */
const MAX_OUTPUT_CHARS = 8 * 1024;

/**
 * 构造一个行为可注入的假工具
 * @param {(args: Record<string, unknown>) => Promise<ToolOutput>} execute - execute 实现
 * @returns {Tool} 假工具实例
 */
function makeTool(
  execute: (args: Record<string, unknown>) => Promise<ToolOutput>
): Tool {
  return {
    name: "fake",
    description: "测试工具",
    parameters: { type: "object", properties: {} },
    execute,
  };
}

/**
 * 构造一次工具调用请求
 * @param {string} args - 参数的 JSON 字符串
 * @returns {ToolCall} 工具调用请求
 */
function makeCall(args: string): ToolCall {
  return { callId: "call_1", name: "fake", arguments: args };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("executeToolCall", () => {
  it("参数为合法 JSON 时解析后交给工具执行", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "成功" }));

    const result = await executeToolCall(
      makeTool(execute),
      makeCall('{"path":"a.txt"}')
    );

    expect(execute).toHaveBeenCalledWith({ path: "a.txt" });
    expect(result).toEqual({ callId: "call_1", ok: true, output: "成功" });
  });

  it("参数为空串时按空对象处理", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "ok" }));

    await executeToolCall(makeTool(execute), makeCall(""));

    expect(execute).toHaveBeenCalledWith({});
  });

  it("参数不是合法 JSON 时返回失败结果，不调用工具", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "ok" }));

    const result = await executeToolCall(makeTool(execute), makeCall("{bad"));

    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.output).toContain("参数不是合法的 JSON 对象");
  });

  it("工具抛错时转为失败结果，不向上抛出", async () => {
    const tool = makeTool(async () => {
      throw new Error("磁盘炸了");
    });

    const result = await executeToolCall(tool, makeCall("{}"));

    expect(result.ok).toBe(false);
    expect(result.output).toBe("工具执行失败: 磁盘炸了");
  });

  it("工具执行超过超时时间时返回超时失败结果", async () => {
    vi.useFakeTimers();
    const tool = makeTool(() => new Promise<ToolOutput>(() => {}));

    const promise = executeToolCall(tool, makeCall("{}"));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.output).toContain("工具执行超时");
  });

  it("超长输出被截断并附带原文长度说明", async () => {
    const long = "a".repeat(MAX_OUTPUT_CHARS + 100);
    const tool = makeTool(async () => ({ ok: true, output: long }));

    const result = await executeToolCall(tool, makeCall("{}"));

    expect(result.output.startsWith("a".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(result.output).toContain(
      `...（输出过长已截断，原文共 ${long.length} 字符）`
    );
    expect(result.output.length).toBeLessThan(long.length + 40);
  });

  it("输出未超限时保持原样", async () => {
    const short = "hello";
    const tool = makeTool(async () => ({ ok: true, output: short }));

    const result = await executeToolCall(tool, makeCall("{}"));

    expect(result.output).toBe(short);
  });
});
