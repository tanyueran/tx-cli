import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import { streamResponse } from "../src/core/llm/client";
import { CliError } from "../src/shared/errors";
import type { LlmConfig } from "../src/core/llm/types";

const { responsesCreate } = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
}));

// 用可控的假实现替换 openai SDK：只保留 client.ts 用到的 responses.create
vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    default: class OpenAI {
      static APIError = APIError;
      responses = { create: responsesCreate };
    },
  };
});

/** 测试用的最小 LLM 配置 */
const config: LlmConfig = {
  apiKey: "sk-test",
  baseUrl: "https://api.test.com/v1",
  model: "test-model",
};

/**
 * 把数组包装为 async 迭代器，用于模拟流式接口的分片响应
 * @param {T[]} items - 待逐个产出的分片
 * @returns {AsyncGenerator<T>} 异步迭代器
 */
async function* toAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * 用给定事件数组模拟一次 Responses 流式响应
 * @param {unknown[]} events - 流式事件数组
 * @returns {void}
 */
function mockResponsesStream(events: unknown[]): void {
  responsesCreate.mockImplementation(() => toAsync(events));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("streamResponse", () => {
  it("聚合回答文本与工具调用，且以无状态模式发送（store=false）", async () => {
    mockResponsesStream([
      { type: "response.reasoning_text.delta", delta: "琢磨" },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "c1",
          name: "read_file",
          arguments: "{}",
        },
      },
    ]);
    const onDelta = vi.fn();
    const onReasoningDelta = vi.fn();

    const result = await streamResponse({
      config,
      input: [{ type: "message", role: "user", content: "问题" }],
      onDelta,
      onReasoningDelta,
    });

    expect(result.reply).toBe("hi");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: "{}" },
    ]);
    expect(onReasoningDelta).toHaveBeenCalledWith("琢磨");
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ store: false })
    );
  });

  it("未传思考回调时，收到思考增量也不报错", async () => {
    mockResponsesStream([
      { type: "response.reasoning_text.delta", delta: "x" },
    ]);

    const result = await streamResponse({
      config,
      input: [{ type: "message", role: "user", content: "问题" }],
      onDelta: vi.fn(),
    });

    expect(result.reply).toBe("");
  });

  it("历史项转换为 Responses 输入项（消息与工具轮次）", async () => {
    mockResponsesStream([{ type: "response.output_text.delta", delta: "done" }]);

    await streamResponse({
      config,
      input: [
        { type: "message", role: "user", content: "读文件" },
        {
          type: "function_call",
          callId: "c1",
          name: "read_file",
          arguments: '{"path":"x"}',
        },
        { type: "function_call_output", callId: "c1", output: "文件内容" },
      ],
      onDelta: vi.fn(),
    });

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          { role: "user", content: "读文件" },
          {
            type: "function_call",
            call_id: "c1",
            name: "read_file",
            arguments: '{"path":"x"}',
          },
          { type: "function_call_output", call_id: "c1", output: "文件内容" },
        ],
      })
    );
  });

  it("把思考扩展字段原样附加到请求体", async () => {
    mockResponsesStream([{ type: "response.output_text.delta", delta: "ok" }]);

    await streamResponse({
      config,
      input: [{ type: "message", role: "user", content: "问题" }],
      extraBody: { reasoning: { effort: "low" } },
      onDelta: vi.fn(),
    });

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: "low" } })
    );
  });

  it("网络失败映射为可读的 CliError", async () => {
    responsesCreate.mockRejectedValue(new Error("fetch failed"));

    const params = {
      config,
      input: [{ type: "message" as const, role: "user" as const, content: "问题" }],
      onDelta: vi.fn(),
    };
    await expect(streamResponse(params)).rejects.toThrow(CliError);
    await expect(streamResponse(params)).rejects.toThrow("网络请求失败");
  });

  it("HTTP 401 映射为密钥无效提示", async () => {
    const apiError = new (OpenAI as unknown as {
      APIError: new (status: number, message: string) => Error;
    }).APIError(401, "unauthorized");
    responsesCreate.mockRejectedValue(apiError);

    await expect(
      streamResponse({
        config,
        input: [{ type: "message", role: "user", content: "问题" }],
        onDelta: vi.fn(),
      })
    ).rejects.toThrow("API Key 无效或未授权");
  });
});
