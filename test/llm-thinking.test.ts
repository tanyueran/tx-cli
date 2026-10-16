import { describe, it, expect } from "vitest";
import {
  describeThinkingStyle,
  isToggleOnlyStyle,
  parseThinkingLevel,
  parseThinkingStyle,
  resolveResponsesThinkingFields,
  resolveThinkingStyle,
} from "../src/core/llm/thinking";
import type { LlmConfig } from "../src/types/llm";

/**
 * 构造一份最小可用的 LLM 配置，用于测试思考风格推断
 * @param {Partial<LlmConfig>} overrides - 需要覆盖的字段
 * @returns {LlmConfig} 完整的 LLM 配置
 */
function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    ...overrides,
  };
}

describe("parseThinkingLevel", () => {
  it("接受全部合法档位", () => {
    expect(parseThinkingLevel("off")).toBe("off");
    expect(parseThinkingLevel("low")).toBe("low");
    expect(parseThinkingLevel("medium")).toBe("medium");
    expect(parseThinkingLevel("high")).toBe("high");
  });

  it("大小写不敏感且去除首尾空格", () => {
    expect(parseThinkingLevel("  HIGH ")).toBe("high");
  });

  it("未传入或空串时返回 undefined", () => {
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
  });

  it("非法档位抛出错误并列出可选值", () => {
    expect(() => parseThinkingLevel("ultra")).toThrow(
      /无法识别的思考档位 "ultra".*off \| low \| medium \| high/
    );
  });
});

describe("parseThinkingStyle", () => {
  it("接受全部合法风格", () => {
    expect(parseThinkingStyle("reasoning_effort")).toBe("reasoning_effort");
    expect(parseThinkingStyle("thinking")).toBe("thinking");
    expect(parseThinkingStyle("enable_thinking")).toBe("enable_thinking");
    expect(parseThinkingStyle("none")).toBe("none");
  });

  it("未传入或空串时返回 undefined（交给 baseUrl 推断）", () => {
    expect(parseThinkingStyle(undefined)).toBeUndefined();
    expect(parseThinkingStyle("")).toBeUndefined();
  });

  it("非法风格抛出错误", () => {
    expect(() => parseThinkingStyle("foo")).toThrow(/无法识别的思考协议风格/);
  });
});

describe("resolveThinkingStyle", () => {
  it("显式配置优先于 baseUrl 推断", () => {
    const config = makeConfig({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      thinkingStyle: "none",
    });
    expect(resolveThinkingStyle(config)).toBe("none");
  });

  it("火山方舟/豆包/智谱按 thinking 风格推断", () => {
    expect(
      resolveThinkingStyle(
        makeConfig({ baseUrl: "https://ark.cn-beijing.volces.com/api/v3" })
      )
    ).toBe("thinking");
    expect(
      resolveThinkingStyle(makeConfig({ baseUrl: "https://api.bigmodel.cn/v1" }))
    ).toBe("thinking");
  });

  it("阿里 DashScope 按 enable_thinking 风格推断", () => {
    expect(
      resolveThinkingStyle(
        makeConfig({
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        })
      )
    ).toBe("enable_thinking");
  });

  it("其余服务默认 reasoning_effort", () => {
    expect(resolveThinkingStyle(makeConfig())).toBe("reasoning_effort");
  });
});

describe("resolveResponsesThinkingFields", () => {
  it("reasoning_effort 风格映射为 reasoning.effort", () => {
    expect(resolveResponsesThinkingFields("high", "reasoning_effort")).toEqual({
      reasoning: { effort: "high" },
    });
  });

  it("reasoning_effort 风格下 off 不下发任何字段", () => {
    expect(resolveResponsesThinkingFields("off", "reasoning_effort")).toEqual(
      {}
    );
  });

  it("effortMap 对 reasoning.effort 同样生效", () => {
    expect(
      resolveResponsesThinkingFields("low", "reasoning_effort", {
        low: "high",
      })
    ).toEqual({ reasoning: { effort: "high" } });
  });

  it("thinking 风格折算为开关，off 为 disabled", () => {
    expect(resolveResponsesThinkingFields("high", "thinking")).toEqual({
      thinking: { type: "enabled" },
    });
    expect(resolveResponsesThinkingFields("off", "thinking")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("enable_thinking 风格折算为布尔开关", () => {
    expect(resolveResponsesThinkingFields("low", "enable_thinking")).toEqual({
      enable_thinking: true,
    });
    expect(resolveResponsesThinkingFields("off", "enable_thinking")).toEqual({
      enable_thinking: false,
    });
  });

  it("none 风格永远不下发思考字段", () => {
    expect(resolveResponsesThinkingFields("high", "none")).toEqual({});
  });
});

describe("isToggleOnlyStyle", () => {
  it("thinking 与 enable_thinking 为开关式风格", () => {
    expect(isToggleOnlyStyle("thinking")).toBe(true);
    expect(isToggleOnlyStyle("enable_thinking")).toBe(true);
  });

  it("reasoning_effort 与 none 非开关式风格", () => {
    expect(isToggleOnlyStyle("reasoning_effort")).toBe(false);
    expect(isToggleOnlyStyle("none")).toBe(false);
  });
});

describe("describeThinkingStyle", () => {
  it("每种风格都返回非空说明文本", () => {
    for (const style of [
      "reasoning_effort",
      "thinking",
      "enable_thinking",
      "none",
    ] as const) {
      expect(describeThinkingStyle(style).length).toBeGreaterThan(0);
    }
  });
});
