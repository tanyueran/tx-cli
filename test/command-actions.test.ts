import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadLlmConfig } from "../src/core/llm";
import { runOneShotChat, runReplChat } from "../src/core/conversation/chat";
import { runOneShotAgent, runReplAgent } from "../src/core/conversation/agent";
import { runChatAction } from "../src/program/command/chat-command";
import {
  buildSandboxOptions,
  runAgentAction,
} from "../src/program/command/agent-command";
import type { LlmConfig } from "../src/core/llm/types";

// loadLlmConfig 保留真实签名但替换实现（真实实现会进入交互向导并写盘），parseThinkingLevel 等保持真实逻辑
vi.mock("../src/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/llm")>();
  return { ...actual, loadLlmConfig: vi.fn() };
});

// 会话层整体替换：命令执行体只负责分流，conversation 层行为不属于本文件测试范围
vi.mock("../src/core/conversation/chat", () => ({
  runOneShotChat: vi.fn(),
  runReplChat: vi.fn(),
}));

vi.mock("../src/core/conversation/agent", () => ({
  runOneShotAgent: vi.fn(),
  runReplAgent: vi.fn(),
}));

/**
 * 构造一份最小可用的 LLM 配置，作为 loadLlmConfig 的替身返回值
 * @param {Partial<LlmConfig>} overrides - 需要覆盖的字段
 * @returns {LlmConfig} 完整的 LLM 配置
 */
function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadLlmConfig).mockResolvedValue(makeConfig());
});

describe("runChatAction", () => {
  it("传入问题走单次问答：多个词以空格合并，思考档位透传", async () => {
    const config = await loadLlmConfig();

    await runChatAction(["解释", "一下", "这段代码"], { think: "high" });

    expect(runOneShotChat).toHaveBeenCalledTimes(1);
    expect(runOneShotChat).toHaveBeenCalledWith(config, "解释 一下 这段代码", "high");
    expect(runReplChat).not.toHaveBeenCalled();
  });

  it("未传参进入多轮对话模式", async () => {
    const config = await loadLlmConfig();

    await runChatAction([], {});

    expect(runReplChat).toHaveBeenCalledTimes(1);
    expect(runReplChat).toHaveBeenCalledWith(config, undefined);
    expect(runOneShotChat).not.toHaveBeenCalled();
  });

  it("空白问题（空串或纯空格）按未传参处理进入多轮对话", async () => {
    await runChatAction([""], {});
    await runChatAction(["  "], {});
    // join(" ") 后整体 trim：多个纯空格词合并后仍为空白
    await runChatAction([" ", "   "], {});

    expect(runReplChat).toHaveBeenCalledTimes(3);
    expect(runOneShotChat).not.toHaveBeenCalled();
  });

  it("未指定 --think 时档位为 undefined（由会话层按模式兜底）", async () => {
    await runChatAction(["问题"], {});

    expect(runOneShotChat).toHaveBeenCalledWith(
      await loadLlmConfig(),
      "问题",
      undefined,
    );
  });
});

describe("runAgentAction", () => {
  it("传入任务走单次执行：MCP 缺省开启，沙箱选项为空对象走配置默认", async () => {
    const config = await loadLlmConfig();

    await runAgentAction(["修复", "这个", "bug"], {});

    expect(runOneShotAgent).toHaveBeenCalledTimes(1);
    expect(runOneShotAgent).toHaveBeenCalledWith(
      config,
      "修复 这个 bug",
      undefined,
      true,
      {},
    );
    expect(runReplAgent).not.toHaveBeenCalled();
  });

  it("未传参进入多轮任务模式", async () => {
    const config = await loadLlmConfig();

    await runAgentAction([], {});

    expect(runReplAgent).toHaveBeenCalledTimes(1);
    expect(runReplAgent).toHaveBeenCalledWith(config, undefined, true, {});
    expect(runOneShotAgent).not.toHaveBeenCalled();
  });

  it("--no-mcp 显式关闭 MCP 服务器", async () => {
    await runAgentAction(["任务"], { mcp: false });

    expect(runOneShotAgent).toHaveBeenCalledWith(
      await loadLlmConfig(),
      "任务",
      undefined,
      false,
      {},
    );
  });

  it("执行类选项完整映射到沙箱 CLI 选项并透传", async () => {
    await runAgentAction(["任务"], {
      think: "low",
      mcp: false,
      sandbox: "workspace-write",
      approval: "never",
      bash: false,
      sandboxMissing: "allow",
    });

    expect(runOneShotAgent).toHaveBeenCalledWith(
      await loadLlmConfig(),
      "任务",
      "low",
      false,
      {
        level: "workspace-write",
        approval: "never",
        bashEnabled: false,
        missingAction: "allow",
      },
    );
  });

  it("空白任务按未传参处理进入多轮任务模式", async () => {
    await runAgentAction([""], {});
    await runAgentAction(["  ", " "], {});

    expect(runReplAgent).toHaveBeenCalledTimes(2);
    expect(runOneShotAgent).not.toHaveBeenCalled();
  });
});

describe("buildSandboxOptions", () => {
  it("未指定任何沙箱相关项时返回空对象（走配置文件默认）", () => {
    expect(buildSandboxOptions({})).toEqual({});
  });

  it("bash 显式开启（缺省 true）时不置位 bashEnabled", () => {
    expect(buildSandboxOptions({ bash: true })).toEqual({});
  });

  it("bash 为 false（--no-bash）时才置位 bashEnabled", () => {
    expect(buildSandboxOptions({ bash: false })).toEqual({
      bashEnabled: false,
    });
  });

  it("沙箱档位、审批策略与不可用处置逐一映射", () => {
    expect(
      buildSandboxOptions({
        sandbox: "read-only",
        approval: "on-failure",
        sandboxMissing: "deny",
      }),
    ).toEqual({
      level: "read-only",
      approval: "on-failure",
      missingAction: "deny",
    });
  });

  it("未指定的字段不出现在结果中（与配置默认的合并交给装配层）", () => {
    const result = buildSandboxOptions({ sandbox: "danger-full-access" });
    expect(result).toEqual({ level: "danger-full-access" });
    expect(Object.keys(result)).toEqual(["level"]);
  });
});
