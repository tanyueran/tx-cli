import { describe, it, expect } from "vitest";
import {
  buildToolCallInfo,
  createSoftConvergeNotice,
  createStreamRenderer,
  createToolCallLogger,
} from "@tanyueran/agent-core/conversation/loop/renderer";
import type { Tool } from "@tanyueran/agent-core/tools";
import { MockOutputChannel } from "./helpers/mock-channels";

/** 构造带自定义渲染的工具桩 */
function makeTool(renderCall?: (args: Record<string, unknown>) => string): Tool {
  return {
    name: "stub_tool",
    description: "桩工具",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true, output: "" }),
    ...(renderCall ? { renderCall } : {}),
  } as unknown as Tool;
}

describe("buildToolCallInfo", () => {
  it("工具提供 renderCall 时带出自定义渲染文本", () => {
    const info = buildToolCallInfo(
      { callId: "c1", name: "write_todos", arguments: '{"items":[]}' },
      makeTool(() => "清单视图"),
    );
    expect(info.name).toBe("write_todos");
    expect(info.arguments).toBe('{"items":[]}');
    expect(info.renderedCall).toBe("清单视图");
  });

  it("工具未注册时回退到原始参数", () => {
    const info = buildToolCallInfo({
      callId: "c1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    });
    expect(info.renderedCall).toBeUndefined();
    expect(info.arguments).toBe('{"path":"a.ts"}');
  });

  it("参数非法 JSON 时回退到原始参数，不抛错", () => {
    const info = buildToolCallInfo(
      { callId: "c1", name: "read_file", arguments: "not-json" },
      makeTool(() => "不应出现"),
    );
    expect(info.renderedCall).toBeUndefined();
  });

  it("参数为数组时不走自定义渲染", () => {
    const info = buildToolCallInfo(
      { callId: "c1", name: "read_file", arguments: "[1,2]" },
      makeTool(() => "不应出现"),
    );
    expect(info.renderedCall).toBeUndefined();
  });
});

describe("createStreamRenderer", () => {
  it("把正文与思考增量转译到输出通道", () => {
    const output = new MockOutputChannel();
    const renderer = createStreamRenderer(output);
    renderer.onReasoningDelta("想");
    renderer.onDelta("答");
    expect(output.records.map((r) => r.text)).toEqual(["想", "答"]);
  });

  it("正文增量前先结束思考块", () => {
    const output = new MockOutputChannel();
    const renderer = createStreamRenderer(output);
    renderer.onReasoningDelta("想");
    renderer.onDelta("答");
    // endThinking 不产出文本，只标记状态
    expect(output.texts).toEqual([]);
  });
});

describe("createToolCallLogger", () => {
  it("结束思考并补换行后输出工具调用信息", () => {
    const output = new MockOutputChannel();
    const renderer = createStreamRenderer(output);
    const logger = createToolCallLogger(renderer, output);
    logger({
      callId: "c1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    });
    expect(output.records).toHaveLength(1);
    expect(output.records[0].toolCall?.name).toBe("read_file");
  });
});

describe("createSoftConvergeNotice", () => {
  it("软收敛提示经输出通道输出，且包含轮数上限", () => {
    const output = new MockOutputChannel();
    const renderer = createStreamRenderer(output);
    const notice = createSoftConvergeNotice(renderer, output, 12);
    notice();
    expect(output.texts.join("\n")).toContain("12 轮");
  });
});
