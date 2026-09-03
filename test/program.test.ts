import { describe, it, expect } from "vitest";
import { createProgram } from "../src/program";

describe("createProgram", () => {
  it("注册了全部命令，且顺序与注册器列表一致", () => {
    const names = createProgram().commands.map((cmd) => cmd.name());
    expect(names).toEqual([
      "create",
      "add",
      "server",
      "git-rename",
      "commit-fix",
    ]);
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
