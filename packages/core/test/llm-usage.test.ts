import { describe, it, expect } from "vitest";
import {
  addUsage,
  createEmptyUsage,
  estimateCost,
  formatCost,
  formatTokenCount,
  formatUsageSummary,
  isEmptyUsage,
} from "@tx-cli/core/llm/usage";
import type { LlmPricing, TokenUsage } from "@tx-cli/core/llm/types";

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

describe("token 用量工具", () => {
  it("零值用量被判定为空", () => {
    expect(isEmptyUsage(createEmptyUsage())).toBe(true);
    expect(isEmptyUsage(makeUsage(1, 0))).toBe(false);
  });

  it("累加用量且不修改入参", () => {
    const base = makeUsage(100, 20);
    const delta = makeUsage(200, 30);

    const total = addUsage(base, delta);

    expect(total).toEqual(makeUsage(300, 50));
    expect(base).toEqual(makeUsage(100, 20));
  });

  it("大数值使用 k / M 紧凑单位并去掉小数尾零", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(1200.6)).toBe("1.2k");
    // 999.95k 四舍五入进位为 M，不出现「1000k」
    expect(formatTokenCount(999_950)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("未配置单价时不估算费用", () => {
    const usage = makeUsage(1000, 500);

    expect(estimateCost(usage, undefined)).toBeUndefined();
    expect(formatUsageSummary(usage)).toBe("输入 1k · 输出 500");
  });

  it("按每百万 token 单价估算并展示费用", () => {
    const usage = makeUsage(1_000_000, 500_000);
    const pricing: LlmPricing = {
      inputPerMillion: 2,
      outputPerMillion: 4,
      currency: "¥",
    };

    expect(estimateCost(usage, pricing)).toBe(4);
    expect(formatUsageSummary(usage, pricing)).toBe(
      "输入 1M · 输出 500k · 约 ¥4.00",
    );
  });

  it("小额费用保留四位小数，支持自定义币种", () => {
    const usage = makeUsage(1000, 0);
    const pricing: LlmPricing = { inputPerMillion: 2, currency: "$" };

    expect(formatCost(0.002, "$")).toBe("$0.0020");
    expect(formatUsageSummary(usage, pricing)).toBe(
      "输入 1k · 输出 0 · 约 $0.0020",
    );
  });

  it("非法单价字段按未配置处理", () => {
    const usage = makeUsage(1000, 500);
    const pricing = {
      inputPerMillion: Number.NaN,
      outputPerMillion: -1,
    } as LlmPricing;

    expect(estimateCost(usage, pricing)).toBeUndefined();
  });
});
