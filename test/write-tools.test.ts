import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../src/core/tools/builtin/write-file";
import { editFileTool } from "../src/core/tools/builtin/edit-file";
import { wrapToolWithPermission } from "../src/core/tools/permission";
import { SandboxContext } from "../src/core/sandbox/runtime/sandbox-context";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config/schema";
import { noopProvider } from "../src/core/sandbox/providers/noop";
import type { ApprovalChoice, Approver } from "../src/core/sandbox/types";
import type { SandboxFileConfig } from "../src/core/sandbox/config/schema";

/** 测试用临时目录（beforeEach 重建，模拟项目根） */
let dir: string;

/**
 * 记录调用次数的假审批器：ask 返回预设选择
 */
class FakeApprover implements Approver {
  /** ask 被调用的次数 */
  askCalls = 0;

  /**
   * @param {ApprovalChoice} choice - ask 应答
   */
  constructor(private readonly choice: ApprovalChoice = { kind: "once" }) {}

  /**
   * 记录调用并返回预设选择
   * @returns {Promise<ApprovalChoice>} 预设选择
   */
  async ask(): Promise<ApprovalChoice> {
    this.askCalls += 1;
    return this.choice;
  }

  /**
   * 升级问询：测试中不应触达
   * @returns {Promise<boolean>} 恒 false
   */
  async askEscalation(): Promise<boolean> {
    return false;
  }
}

/**
 * 构造测试用沙箱上下文（bash-tool.test.ts 同款）
 * @param {object} options - 上下文选项
 * @param {SandboxFileConfig["level"]} options.level - 沙箱档位
 * @param {SandboxFileConfig["rules"]} options.rules - 权限规则
 * @param {Approver} options.approver - 审批器
 * @returns {SandboxContext} 上下文实例
 */
function makeContext(options: {
  level?: SandboxFileConfig["level"];
  rules?: SandboxFileConfig["rules"];
  approver?: Approver;
} = {}): SandboxContext {
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    level: options.level ?? DEFAULT_SANDBOX_CONFIG.level,
    approval: "on-failure",
    rules: options.rules ?? DEFAULT_SANDBOX_CONFIG.rules,
  };
  return new SandboxContext({
    config,
    level: options.level ?? config.level,
    approval: config.approval,
    provider: noopProvider,
    isInteractive: true,
    approver: options.approver ?? new FakeApprover(),
    projectConfigPath: join(dir, "project-config.json"),
    auditPath: join(dir, "audit.jsonl"),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-write-tools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("write_file 工具（直连执行）", () => {
  it("新建文件并自动创建父目录", async () => {
    const target = join(dir, "src", "utils", "a.ts");
    const result = await writeFileTool.execute({
      path: target,
      content: "export const a = 1;\n",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("已创建");
    expect(readFileSync(target, "utf-8")).toBe("export const a = 1;\n");
  });

  it("覆盖已有文件并提示覆盖", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "旧内容", "utf-8");
    const result = await writeFileTool.execute({ path: target, content: "新内容" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("已覆盖");
    expect(readFileSync(target, "utf-8")).toBe("新内容");
  });

  it("空字符串内容表示清空文件", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "旧内容", "utf-8");
    const result = await writeFileTool.execute({ path: target, content: "" });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("");
  });

  it("缺少 path 或 content 时失败", async () => {
    const noPath = await writeFileTool.execute({ content: "x" });
    expect(noPath.ok).toBe(false);
    expect(noPath.output).toContain("path");
    const noContent = await writeFileTool.execute({ path: join(dir, "a.txt") });
    expect(noContent.ok).toBe(false);
    expect(noContent.output).toContain("content");
  });

  it("目标为已存在目录时失败", async () => {
    const result = await writeFileTool.execute({ path: dir, content: "x" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("写入文件失败");
  });

  it("renderCall 不回显文件内容", () => {
    const text = writeFileTool.renderCall?.({
      path: join(dir, "a.txt"),
      content: "很长的内容".repeat(100),
    });
    expect(text).toContain("写入");
    expect(text).toContain("新建");
    expect(text).not.toContain("很长的内容");
  });
});

describe("edit_file 工具（直连执行）", () => {
  it("唯一匹配时替换成功", async () => {
    const target = join(dir, "a.ts");
    writeFileSync(target, "const a = 1;\nconst b = 2;\n", "utf-8");
    const result = await editFileTool.execute({
      path: target,
      old_string: "const a = 1;",
      new_string: "const a = 100;",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("const a = 100;\nconst b = 2;\n");
  });

  it("new_string 为空字符串表示删除片段", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "hello world", "utf-8");
    const result = await editFileTool.execute({
      path: target,
      old_string: " world",
      new_string: "",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("hello");
  });

  it("old_string 未出现时失败并提示先读取", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "内容", "utf-8");
    const result = await editFileTool.execute({
      path: target,
      old_string: "不存在",
      new_string: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("未在");
    expect(result.output).toContain("read_file");
  });

  it("old_string 多处出现时失败并提示扩大范围", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "foo\nfoo\nfoo\n", "utf-8");
    const result = await editFileTool.execute({
      path: target,
      old_string: "foo",
      new_string: "bar",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("3 次");
    expect(result.output).toContain("唯一");
  });

  it("old_string 与 new_string 相同时失败", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "内容", "utf-8");
    const result = await editFileTool.execute({
      path: target,
      old_string: "内容",
      new_string: "内容",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("相同");
  });

  it("old_string 为空或参数缺失时失败", async () => {
    const empty = await editFileTool.execute({
      path: join(dir, "a.txt"),
      old_string: "",
      new_string: "x",
    });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("old_string");
    const missing = await editFileTool.execute({ path: join(dir, "a.txt") });
    expect(missing.ok).toBe(false);
  });

  it("文件不存在时失败", async () => {
    const result = await editFileTool.execute({
      path: join(dir, "nope.txt"),
      old_string: "a",
      new_string: "b",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("读取文件失败");
  });

  it("renderCall 不回显新旧文本", () => {
    const text = editFileTool.renderCall?.({
      path: join(dir, "a.txt"),
      old_string: "秘密原文".repeat(50),
      new_string: "新文本",
    });
    expect(text).toContain("编辑");
    expect(text).not.toContain("秘密原文");
  });
});

describe("写工具经权限门卫（wrapToolWithPermission）", () => {
  it("read-only 档禁止一切写入", async () => {
    const sandbox = makeContext({ level: "read-only" });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    const result = await tool.execute({ path: join(dir, "a.txt"), content: "x" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("禁止一切文件写入");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("workspace-write 档允许临时目录内写入", async () => {
    const sandbox = makeContext({ level: "workspace-write" });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    const result = await tool.execute({ path: join(dir, "a.txt"), content: "x" });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("x");
  });

  it("workspace-write 档拒绝禁写模式（.env）", async () => {
    const sandbox = makeContext({ level: "workspace-write" });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    const result = await tool.execute({
      path: join(dir, ".env"),
      content: "SECRET=1",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("禁写模式");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("workspace-write 档允许 edit_file 编辑临时目录内文件", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "hello", "utf-8");
    const sandbox = makeContext({ level: "workspace-write" });
    const tool = wrapToolWithPermission(editFileTool, sandbox);
    const result = await tool.execute({
      path: target,
      old_string: "hello",
      new_string: "world",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("world");
  });

  it("ask 规则命中时进入审批，批准后执行", async () => {
    const approver = new FakeApprover({ kind: "once" });
    const sandbox = makeContext({
      level: "workspace-write",
      rules: { allow: [], ask: ["write_file"], deny: [] },
      approver,
    });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    const result = await tool.execute({ path: join(dir, "a.txt"), content: "x" });
    expect(approver.askCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("x");
  });

  it("短名规则 Write(...) 也能命中 write_file（别名归一化）", async () => {
    const approver = new FakeApprover({ kind: "once" });
    const sandbox = makeContext({
      level: "workspace-write",
      rules: { allow: [], ask: [`Write(${dir}/**)`], deny: [] },
      approver,
    });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    await tool.execute({ path: join(dir, "a.txt"), content: "x" });
    expect(approver.askCalls).toBe(1);
  });

  it("串行工具并发调用仍全部成功（会话级队列）", async () => {
    const sandbox = makeContext({ level: "workspace-write" });
    const tool = wrapToolWithPermission(writeFileTool, sandbox);
    const results = await Promise.all([
      tool.execute({ path: join(dir, "a.txt"), content: "a" }),
      tool.execute({ path: join(dir, "b.txt"), content: "b" }),
      tool.execute({ path: join(dir, "c.txt"), content: "c" }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("b");
  });
});
