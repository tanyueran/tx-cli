import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeConversationTurn } from "@tx-cli/core/conversation/loop/execute-turn";
import { streamResponse } from "@tx-cli/core/llm/client";
import type {
  LlmConfig,
  ResponseHistoryItem,
} from "@tx-cli/core/llm/types";
import type { Tool } from "@tx-cli/core/tools";
import { MockOutputChannel } from "./helpers/mock-channels";

const { streamResponseMock } = vi.hoisted(() => ({
  streamResponseMock: vi.fn(),
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

type StreamResponseOptions = Parameters<typeof streamResponse>[0];

/** 测试用 LLM 配置；streamResponse 已替换，不会触发真实模型或网络 */
const llmConfig: LlmConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

beforeEach(() => {
  streamResponseMock.mockReset();
});

describe("工具异常后的真实软收敛", () => {
  it("上限 1 时回传配对失败结果，第二轮不再下发工具并正常最终作答", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("检索服务崩溃"));
    const throwingTool: Tool = {
      name: "throwing_tool",
      description: "首轮必定抛错的已注册测试工具",
      parameters: { type: "object", properties: {} },
      execute,
    };
    streamResponseMock
      .mockResolvedValueOnce({
        reply: "",
        toolCalls: [
          { callId: "call_boom", name: "throwing_tool", arguments: "{}" },
        ],
      })
      .mockImplementationOnce(async (options: StreamResponseOptions) => {
        expect(options.tools).toBeUndefined();
        expect(options.input).toEqual([
          { type: "message", role: "user", content: "请检索资料" },
          {
            type: "function_call",
            callId: "call_boom",
            name: "throwing_tool",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            callId: "call_boom",
            output: "工具执行失败: 检索服务崩溃",
          },
        ] satisfies ResponseHistoryItem[]);
        options.onDelta("已根据失败结果作答");
        return { reply: "已根据失败结果作答", toolCalls: [] };
      });
    const history: ResponseHistoryItem[] = [];
    const output = new MockOutputChannel();

    const reply = await executeConversationTurn({
      llmConfig,
      thinkingLevel: "off",
      thinkingStyle: "none",
      history,
      userInput: "请检索资料",
      instructions: "测试系统提示",
      tools: [throwingTool],
      advertisedTools: [throwingTool],
      maxIterations: 1,
      output,
    });

    expect(reply).toBe("已根据失败结果作答");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(streamResponseMock).toHaveBeenCalledTimes(2);
    expect(output.texts).toContain(
      "已达到工具调用轮数上限（1 轮），AI 将基于已有信息直接作答",
    );
    expect(history.at(-1)).toEqual({
      type: "message",
      role: "assistant",
      content: "已根据失败结果作答",
    });
  });
});
