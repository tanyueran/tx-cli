import { describe, it, expect } from "vitest";
import { formatUsageTable } from "../src/channels/usage-table";
import { stripAnsi } from "@tanyueran/agent-common/string";
import type { TokenUsage } from "@tanyueran/agent-core/llm/types";

/**
 * 构造测试用量
 * @param {number} inputTokens - 输入 token
 * @param {number} outputTokens - 输出 token
 * @returns {TokenUsage} 用量对象
 */
function makeUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

describe("终端用量表格", () => {
  it("渲染本轮/累计两行用量表格并按列对齐", () => {
    const table = stripAnsi(
      formatUsageTable([
        { label: "本轮", usage: makeUsage(1234, 456), emphasis: true },
        { label: "累计", usage: makeUsage(2468, 912) },
      ]),
    );
    const lines = table.split("\n");

    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("┌──────┬──────┬──────┬──────┐");
    expect(lines[1]).toBe("│ 项目 │ 输入 │ 输出 │ 费用 │");
    expect(lines[3]).toBe("│ 本轮 │ 1.2k │ 456  │ -    │");
    expect(lines[4]).toBe("│ 累计 │ 2.5k │ 912  │ -    │");
    expect(lines[5]).toBe("└──────┴──────┴──────┴──────┘");
  });

  it("配置单价时费用列展示估算金额", () => {
    const table = stripAnsi(
      formatUsageTable(
        [{ label: "本次", usage: makeUsage(1_000_000, 0), emphasis: true }],
        { inputPerMillion: 2 },
      ),
    );

    expect(table).toContain("本次");
    expect(table).toContain("¥2.00");
  });
});
