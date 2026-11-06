import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyUsage } from "@tx-cli/core/llm";
import {
  formatSessionMarkdown,
  writeSessionMarkdown,
} from "@tx-cli/core/conversation/repl/session-export";
import type {
  ResponseHistoryItem,
  TokenUsage,
} from "@tx-cli/core/llm/types";

/**
 * 构造带一次工具调用的示例历史
 * @returns {ResponseHistoryItem[]} 用户提问 → 工具调用与结果 → 助手回答
 */
function makeHistory(): ResponseHistoryItem[] {
  return [
    { type: "message", role: "user", content: "看看 package.json" },
    {
      type: "function_call",
      callId: "call-1",
      name: "read_file",
      arguments: '{"path":"package.json"}',
    },
    {
      type: "function_call_output",
      callId: "call-1",
      output: '{"name":"tx-cli"}',
    },
    { type: "message", role: "assistant", content: "项目名是 `tx-cli`。" },
  ];
}

/**
 * 构造导出元信息
 * @param {TokenUsage} [usage] - 自定义用量
 * @returns {object} 会话导出元信息
 */
function makeMeta(usage: TokenUsage = createEmptyUsage()) {
  return {
    modeLabel: "对话模式",
    model: "deepseek-chat",
    thinkingLevel: "low" as const,
    usage,
    createdAt: new Date(2026, 10, 2, 15, 30, 0, 123),
  };
}

describe("formatSessionMarkdown", () => {
  it("输出文件头、消息正文与工具调用配对", () => {
    const markdown = formatSessionMarkdown(makeHistory(), makeMeta());

    expect(markdown).toContain("# tx-cli 会话记录");
    expect(markdown).toContain("- 模式：对话模式");
    expect(markdown).toContain("- 模型：deepseek-chat · 思考 low");
    expect(markdown).toContain("- 导出时间：2026-11-02 15:30:00");
    expect(markdown).toContain("- 历史消息：4 条");
    expect(markdown).toContain("## 用户");
    expect(markdown).toContain("看看 package.json");
    expect(markdown).toContain("### 工具调用 · read_file");
    expect(markdown).toContain('"path": "package.json"');
    expect(markdown).toContain("### 工具结果 · read_file");
    expect(markdown).toContain("## 助手");
    expect(markdown).toContain("项目名是 `tx-cli`。");
  });

  it("头部展示累计用量与费用估算", () => {
    const markdown = formatSessionMarkdown(makeHistory(), {
      ...makeMeta({
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        cachedTokens: 0,
        reasoningTokens: 0,
      }),
      pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: "¥" },
    });

    expect(markdown).toContain(
      "- 累计用量：输入 1.2k · 输出 300 · 约 ¥0.0048",
    );
  });

  it("超长工具输出截断并标注原长度", () => {
    const longOutput = "x".repeat(5000);
    const markdown = formatSessionMarkdown(
      [
        {
          type: "function_call",
          callId: "call-2",
          name: "grep",
          arguments: '{"pattern":"x"}',
        },
        { type: "function_call_output", callId: "call-2", output: longOutput },
      ],
      makeMeta(),
    );

    expect(markdown).toContain("（已截断，原长度 5000 字符）");
    expect(markdown).not.toContain(longOutput);
  });

  it("空消息与空工具输出给出占位", () => {
    const markdown = formatSessionMarkdown(
      [
        { type: "message", role: "assistant", content: "   " },
        { type: "function_call_output", callId: "missing", output: "" },
      ],
      makeMeta(),
    );

    expect(markdown).not.toContain("## 助手");
    expect(markdown).toContain("（空输出）");
  });
});

describe("writeSessionMarkdown", () => {
  it("写入带时间戳的 Markdown 文件并返回路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tx-cli-session-export-"));
    try {
      const filePath = await writeSessionMarkdown(
        makeHistory(),
        makeMeta(),
        dir,
      );

      expect(filePath.endsWith("tx-cli-session-20261102-153000-123.md")).toBe(
        true,
      );
      const content = await readFile(filePath, "utf8");
      expect(content).toContain("看看 package.json");
      expect(content.endsWith("\n")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
