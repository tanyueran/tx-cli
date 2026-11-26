import { describe, it, expect } from "vitest";
import { CliError } from "@tanyueran/agent-common";
import { runSetupWizard } from "@tanyueran/agent-core/llm/config-wizard";
import { createMockChannels } from "./helpers/mock-channels";

describe("runSetupWizard", () => {
  it("未提供会话通道时抛错（core 不持有终端实现）", async () => {
    await expect(runSetupWizard({})).rejects.toBeInstanceOf(CliError);
  });

  it("经交互提示通道逐项收集答案并以已有配置为默认值", async () => {
    const channels = createMockChannels();
    channels.prompt.input = async (message: string) => {
      if (message === "API Key") return "sk-1";
      if (message.startsWith("Base URL")) return "https://example.com/v1";
      return "gpt-test";
    };

    const config = await runSetupWizard(
      { apiKey: "sk-old", model: "gpt-old" },
      channels,
    );

    expect(config).toEqual({
      apiKey: "sk-1",
      baseUrl: "https://example.com/v1",
      model: "gpt-test",
    });
  });
});
