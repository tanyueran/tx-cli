import { describe, it, expect, vi, beforeEach } from "vitest";
import { CancelError } from "@tx-cli/shared";
import { CliPromptChannel } from "../src/channels/cli-prompt";

// prompts 是终端交互库，测试中替换为可编排的假实现，避免真实读 stdin
const promptsMock = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: promptsMock }));

describe("CliPromptChannel", () => {
  beforeEach(() => {
    promptsMock.mockReset();
  });

  it("confirm 透传提示文案与默认值，返回确认结果", async () => {
    promptsMock.mockResolvedValue({ confirmed: true });
    const channel = new CliPromptChannel();

    const result = await channel.confirm("确认继续吗？", true);

    expect(result).toBe(true);
    const [questions, options] = promptsMock.mock.calls[0];
    expect(questions).toMatchObject({
      type: "confirm",
      name: "confirmed",
      message: "确认继续吗？",
      initial: true,
    });
    expect(typeof options.onCancel).toBe("function");
  });

  it("select 透传候选项并返回选中的值", async () => {
    promptsMock.mockResolvedValue({ selectedValue: "b" });
    const channel = new CliPromptChannel();

    const result = await channel.select<string>("请选择", [
      { title: "A", value: "a" },
      { title: "B", value: "b" },
    ]);

    expect(result).toBe("b");
    const [questions] = promptsMock.mock.calls[0];
    expect(questions).toMatchObject({
      type: "select",
      name: "selectedValue",
      message: "请选择",
    });
    expect(questions.choices).toHaveLength(2);
  });

  it("input 透传预填默认值并返回去除首尾空格的文本", async () => {
    promptsMock.mockResolvedValue({ text: "  sk-123  " });
    const channel = new CliPromptChannel();

    const result = await channel.input("API Key", "sk-old");

    expect(result).toBe("sk-123");
    const [questions] = promptsMock.mock.calls[0];
    expect(questions).toMatchObject({
      type: "text",
      name: "text",
      message: "API Key",
      initial: "sk-old",
    });
  });

  it("用户取消时 onCancel 抛 CancelError", async () => {
    promptsMock.mockImplementation(async (_questions, options) => {
      options.onCancel();
      return {};
    });
    const channel = new CliPromptChannel();

    await expect(channel.confirm("确认继续吗？")).rejects.toBeInstanceOf(
      CancelError,
    );
  });
});
