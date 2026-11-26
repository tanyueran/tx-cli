import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOneShotChat } from "@tanyueran/agent-core/conversation/chat";
import type { ConversationTurnOptions } from "@tanyueran/agent-core/conversation/loop/execute-turn";
import { DEFAULT_SANDBOX_CONFIG } from "@tanyueran/agent-core/sandbox/config/schema";
import type { SandboxFileConfig } from "@tanyueran/agent-core/sandbox/config/schema";
import type { LlmConfig } from "@tanyueran/agent-core/llm/types";
import { createMockChannels } from "./helpers/mock-channels";

const { loadSandboxConfigMock, executeConversationTurnMock } = vi.hoisted(
  () => ({
    loadSandboxConfigMock: vi.fn(),
    executeConversationTurnMock: vi.fn(),
  }),
);

vi.mock("@tanyueran/agent-core/sandbox/config/load", () => ({
  loadSandboxConfig: loadSandboxConfigMock,
}));

vi.mock("@tanyueran/agent-core/conversation/loop/execute-turn", () => ({
  executeConversationTurn: executeConversationTurnMock,
}));

/** 测试用 LLM 配置；回合入口已被替换，不会创建真实客户端或发起网络请求 */
const llmConfig: LlmConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

/** Chat 模式必须保留的无副作用只读检索工具 */
const READ_ONLY_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
];

/**
 * 构造相互隔离的沙箱配置，避免参数化用例共享或修改默认配置中的嵌套对象
 * @param {Partial<SandboxFileConfig>} overrides - 当前等价类需要覆盖的顶层配置
 * @returns {SandboxFileConfig} 独立的完整沙箱配置
 */
function makeSandboxConfig(
  overrides: Partial<SandboxFileConfig> = {},
): SandboxFileConfig {
  return {
    ...structuredClone(DEFAULT_SANDBOX_CONFIG),
    ...overrides,
  };
}

beforeEach(() => {
  loadSandboxConfigMock.mockReset();
  executeConversationTurnMock.mockReset();
});

describe("Chat 强制只读跨装配", () => {
  it.each([
    {
      label: "沙箱禁用",
      overrides: { enabled: false, level: "read-only" as const },
    },
    {
      label: "workspace-write",
      overrides: { enabled: true, level: "workspace-write" as const },
    },
    {
      label: "danger-full-access",
      overrides: { enabled: true, level: "danger-full-access" as const },
    },
  ])(
    "$label 下执行侧与下发侧都剔除写工具、bash 和 MCP，并保留只读检索",
    async ({ overrides }) => {
      loadSandboxConfigMock.mockReturnValue({
        config: makeSandboxConfig(overrides),
        warnings: [],
      });
      let capturedTurn: ConversationTurnOptions | undefined;
      executeConversationTurnMock.mockImplementation(
        async (options: ConversationTurnOptions) => {
          capturedTurn = options;
          return "只读回答";
        },
      );

      await runOneShotChat({
        llmConfig,
        question: "检索项目信息",
        channels: createMockChannels(),
      });

      expect(executeConversationTurnMock).toHaveBeenCalledTimes(1);
      expect(capturedTurn).toBeDefined();
      for (const tools of [
        capturedTurn?.tools,
        capturedTurn?.advertisedTools,
      ]) {
        expect(tools).toBeDefined();
        const names = tools?.map((tool) => tool.name) ?? [];
        expect(names).toEqual(expect.arrayContaining(READ_ONLY_TOOL_NAMES));
        expect(names).not.toEqual(
          expect.arrayContaining(["write_file", "edit_file", "bash"]),
        );
        expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
        expect(names).not.toContain("discover_mcp_tools");
      }
    },
  );
});
