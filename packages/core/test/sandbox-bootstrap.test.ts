import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxContext } from "@tx-cli/core/sandbox/bootstrap/create-context";
import { DEFAULT_SANDBOX_CONFIG } from "@tx-cli/core/sandbox/config/schema";
import type { SandboxFileConfig } from "@tx-cli/core/sandbox/config/schema";
import { noopProvider } from "@tx-cli/core/sandbox/providers/noop";
import type { SandboxProvider } from "@tx-cli/core/sandbox/types";
import type { SandboxContext } from "@tx-cli/core/sandbox/runtime/sandbox-context";
import { createBashTool } from "@tx-cli/core/tools/builtin/bash";
import { createMockChannels } from "./helpers/mock-channels";

const {
  loadSandboxConfigMock,
  getProviderMock,
  spawnMock,
  isAvailableMock,
  initializeMock,
} = vi.hoisted(() => ({
  loadSandboxConfigMock: vi.fn(),
  getProviderMock: vi.fn(),
  spawnMock: vi.fn(),
  isAvailableMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("@tx-cli/core/sandbox/config/load", () => ({
  loadSandboxConfig: loadSandboxConfigMock,
}));

vi.mock("@tx-cli/core/sandbox/providers/registry", () => ({
  getProvider: getProviderMock,
}));

const unavailableProvider: SandboxProvider = {
  name: "srt",
  isAvailable: isAvailableMock,
  initialize: initializeMock,
  wrapCommand: vi.fn(),
  annotateStderr: vi.fn(),
  dispose: vi.fn(),
};

/**
 * 构造用于 Provider 不可用策略的确定性沙箱配置
 * @param {Partial<SandboxFileConfig>} overrides - 需要覆盖的顶层配置
 * @returns {SandboxFileConfig} 不修改共享默认值的完整配置
 */
function makeSandboxConfig(
  overrides: Partial<SandboxFileConfig> = {},
): SandboxFileConfig {
  return {
    ...structuredClone(DEFAULT_SANDBOX_CONFIG),
    enabled: true,
    level: "workspace-write",
    provider: "srt",
    audit: false,
    network: { allowedDomains: ["example.com"] },
    ...overrides,
  };
}

beforeEach(() => {
  loadSandboxConfigMock.mockReset();
  getProviderMock.mockReset();
  spawnMock.mockReset();
  isAvailableMock.mockReset();
  initializeMock.mockReset();
  loadSandboxConfigMock.mockReturnValue({
    config: makeSandboxConfig(),
    warnings: [],
  });
  getProviderMock.mockImplementation((name: string) => {
    if (name === "srt") {
      return unavailableProvider;
    }
    if (name === "noop") {
      return noopProvider;
    }
    return undefined;
  });
});

describe("createSandboxContext 的 Provider 不可用策略", () => {
  it("默认 deny：探测抛错后失败关闭，bash 门控不启动任何进程", async () => {
    isAvailableMock.mockRejectedValue(new Error("探测依赖缺失"));

    const assembly = await createSandboxContext(
      { level: "workspace-write" },
      { channels: createMockChannels() },
    );

    expect(assembly.sandbox).toBeDefined();
    expect(assembly.sandbox?.provider).toBeUndefined();
    expect(assembly.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("初始化失败：探测依赖缺失"),
        expect.stringContaining("失败关闭模式"),
      ]),
    );
    expect(initializeMock).not.toHaveBeenCalled();

    const result = await createBashTool(
      assembly.sandbox as SandboxContext,
    ).execute({ command: "printf should-not-run" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("当前环境的沙箱不可用");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("显式 allow：探测不可用才降级为 noop，并给出无隔离告警", async () => {
    isAvailableMock.mockResolvedValue(false);

    const assembly = await createSandboxContext(
      { level: "workspace-write", missingAction: "allow" },
      { channels: createMockChannels() },
    );

    expect(assembly.sandbox?.provider).toBe(noopProvider);
    expect(assembly.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--sandbox-missing allow"),
        expect.stringContaining("无隔离执行"),
      ]),
    );
    expect(initializeMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
