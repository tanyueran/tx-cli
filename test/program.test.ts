import { describe, it, expect } from "vitest";
import { createProgram } from "../src/program";

describe("createProgram", () => {
  it("注册了全部命令，且顺序与注册器列表一致", () => {
    const names = createProgram().commands.map((cmd) => cmd.name());
    expect(names).toEqual([
      "create",
      "add",
      "copy",
      "server",
      "git-rename",
      "commit-fix",
      "chat",
      "agent",
    ]);
  });

  it("chat 命令不提供执行类与 MCP 选项（沙箱/审批/bash/MCP 归 agent 命令）", () => {
    const chat = createProgram().commands.find((cmd) => cmd.name() === "chat");
    expect(chat).toBeDefined();
    const flags = chat!.options.map((opt) => opt.long);
    expect(flags).toContain("--think");
    expect(flags).not.toContain("--no-mcp");
    expect(flags).not.toContain("--sandbox");
    expect(flags).not.toContain("--approval");
    expect(flags).not.toContain("--no-bash");
    expect(flags).not.toContain("--sandbox-missing");
  });

  it("agent 命令提供完整执行类选项", () => {
    const agent = createProgram().commands.find(
      (cmd) => cmd.name() === "agent",
    );
    expect(agent).toBeDefined();
    const flags = agent!.options.map((opt) => opt.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--think",
        "--no-mcp",
        "--sandbox",
        "--approval",
        "--no-bash",
        "--sandbox-missing",
      ]),
    );
  });

  it("每次调用返回互相独立的实例，避免全局单例被污染", () => {
    expect(createProgram()).not.toBe(createProgram());
  });

  it("命令都带有描述信息", () => {
    for (const cmd of createProgram().commands) {
      expect(cmd.description()).not.toBe("");
    }
  });
});
