import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import { streamChat, streamResponse } from "../src/core/llm/client";
import { CliError } from "../src/shared/errors";
import type { LlmConfig } from "../src/types/llm";

const { chatCreate, responsesCreate } = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
}));

// 用可控的假实现替换 openai SDK：只保留 client.ts 用到的 chat.completions.create 与 responses.create
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
      chat = { completions: { create: chatCreate } };
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
 * 用给定分片数组模拟一次 Chat Completions 流式响应
 * @param {unknown[]} chunks - 流式分片数组
 * @returns {void}
 */
function mockChatStream(chunks: unknown[]): void {
  chatCreate.mockImplementation(() => toAsync(chunks));
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

describe("streamChat", () => {
  it("聚合文本增量，返回完整回答并逐段回调", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "你" } }] },
      { choices: [{ delta: { content: "好" } }] },
    ]);
    const onDelta = vi.fn();

    const result = await streamChat({ config, messages: [], onDelta });

    expect(result.reply).toBe("你好");
    expect(result.toolCalls).toEqual([]);
    expect(onDelta.mock.calls.map((c) => c[0])).toEqual(["你", "好"]);
  });

  it("深度思考增量单独回调，不计入回答文本", async () => {
    mockChatStream([
      { choices: [{ delta: { reasoning_content: "思考中" } }] },
      { choices: [{ delta: { content: "答案" } }] },
    ]);
    const onDelta = vi.fn();
    const onReasoningDelta = vi.fn();

    const result = await streamChat({
      config,
      messages: [],
      onDelta,
      onReasoningDelta,
    });

    expect(result.reply).toBe("答案");
    expect(onReasoningDelta).toHaveBeenCalledWith("思考中");
    expect(onDelta).toHaveBeenCalledWith("答案");
  });

  it("未传思考回调时，收到思考增量也不报错", async () => {
    mockChatStream([{ choices: [{ delta: { reasoning_content: "x" } }] }]);

    const result = await streamChat({ config, messages: [], onDelta: vi.fn() });

    expect(result.reply).toBe("");
  });

  it("按 index 聚合并拼接分片式 tool_calls，最终按 index 排序", async () => {
    mockChatStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "read_file", arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_b",
                  function: { name: "grep", arguments: '{"p":1}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'th":"x"}' } },
              ],
            },
          },
        ],
      },
    ]);

    const result = await streamChat({ config, messages: [], onDelta: vi.fn() });

    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "read_file", arguments: '{"path":"x"}' },
      { id: "call_b", name: "grep", arguments: '{"p":1}' },
    ]);
  });

  it("把思考扩展字段原样附加到请求体", async () => {
    mockChatStream([{ choices: [{ delta: { content: "ok" } }] }]);

    await streamChat({
      config,
      messages: [],
      extraBody: { reasoning_effort: "low" },
      onDelta: vi.fn(),
    });

    expect(chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "low" })
    );
  });

  it("网络失败映射为可读的 CliError", async () => {
    chatCreate.mockRejectedValue(new Error("fetch failed"));

    await expect(
      streamChat({ config, messages: [], onDelta: vi.fn() })
    ).rejects.toThrow(CliError);
    await expect(
      streamChat({ config, messages: [], onDelta: vi.fn() })
    ).rejects.toThrow("网络请求失败");
  });

  it("HTTP 401 映射为密钥无效提示", async () => {
    const apiError = new (OpenAI as unknown as {
      APIError: new (status: number, message: string) => Error;
    }).APIError(401, "unauthorized");
    chatCreate.mockRejectedValue(apiError);

    await expect(
      streamChat({ config, messages: [], onDelta: vi.fn() })
    ).rejects.toThrow("API Key 无效或未授权");
  });
});

describe("streamResponse", () => {
  it("聚合回答文本、响应 ID 与工具调用", async () => {
    mockResponsesStream([
      { type: "response.created", response: { id: "resp_1" } },
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
      input: "问题",
      onDelta,
      onReasoningDelta,
    });

    expect(result.reply).toBe("hi");
    expect(result.responseId).toBe("resp_1");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: "{}" },
    ]);
    expect(onReasoningDelta).toHaveBeenCalledWith("琢磨");
  });

  it("工具结果数组作为输入时转换为 function_call_output 项", async () => {
    mockResponsesStream([
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_text.delta", delta: "done" },
    ]);

    await streamResponse({
      config,
      input: [{ callId: "c1", output: "文件内容" }],
      onDelta: vi.fn(),
    });

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          { type: "function_call_output", call_id: "c1", output: "文件内容" },
        ],
      })
    );
  });
});
