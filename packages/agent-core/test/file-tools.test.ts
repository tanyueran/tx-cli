import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "@tanyueran/agent-core/tools/builtin/glob";
import { grepTool } from "@tanyueran/agent-core/tools/builtin/grep";
import { listDirTool } from "@tanyueran/agent-core/tools/builtin/list-dir";

/** 测试用临时目录，每个用例独立创建并清理 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-file-tools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("glob 工具（直连执行）", () => {
  it("** 同时匹配根目录与嵌套目录中的文件", async () => {
    mkdirSync(join(dir, "nested", "deep"), { recursive: true });
    writeFileSync(join(dir, "root.ts"), "");
    writeFileSync(join(dir, "nested", "deep", "child.ts"), "");
    writeFileSync(join(dir, "root.txt"), "");

    const result = await globTool.execute({ pattern: "**/*.ts", path: dir });

    expect(result).toEqual({
      ok: true,
      output: "nested/deep/child.ts\nroot.ts",
    });
  });

  it("遍历匹配时忽略 .git 与 node_modules", async () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, ".git", "ignored.ts"), "");
    writeFileSync(join(dir, "node_modules", "ignored.ts"), "");
    writeFileSync(join(dir, "src", "kept.ts"), "");

    const result = await globTool.execute({ pattern: "**/*.ts", path: dir });

    expect(result).toEqual({ ok: true, output: "src/kept.ts" });
  });

  it("匹配文件超过 200 个时只返回前 200 个并附加截断说明", async () => {
    for (let index = 0; index < 205; index++) {
      const name = `file-${String(index).padStart(3, "0")}.txt`;
      writeFileSync(join(dir, name), "");
    }

    const result = await globTool.execute({ pattern: "*.txt", path: dir });
    const lines = result.output.split("\n");

    expect(result.ok).toBe(true);
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe("file-000.txt");
    expect(lines[199]).toBe("file-199.txt");
    expect(lines[200]).toBe("...（仅展示前 200 个匹配）");
    expect(result.output).not.toContain("file-200.txt");
  });
});

describe("grep 工具（直连执行）", () => {
  it("搜索单个文件时支持 ignoreCase 并返回正确行号", async () => {
    const target = join(dir, "sample.txt");
    writeFileSync(target, "Alpha\nbeta\nALPHA\n");

    const result = await grepTool.execute({
      pattern: "alpha",
      path: target,
      ignoreCase: true,
    });

    expect(result).toEqual({
      ok: true,
      output: "sample.txt:1: Alpha\nsample.txt:3: ALPHA",
    });
  });

  it("跨文件搜索累计最多返回 200 行匹配", async () => {
    for (const name of ["a.txt", "b.txt"]) {
      const content = Array.from(
        { length: 150 },
        (_, index) => `hit ${name} ${index}`,
      ).join("\n");
      writeFileSync(join(dir, name), content);
    }

    const result = await grepTool.execute({ pattern: "hit", path: dir });
    const lines = result.output.split("\n");
    const hitLines = lines.slice(0, -1);

    expect(result.ok).toBe(true);
    expect(hitLines).toHaveLength(200);
    expect(hitLines.some((line) => line.startsWith("a.txt:"))).toBe(true);
    expect(hitLines.some((line) => line.startsWith("b.txt:"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("...（仅展示前 200 条匹配）");
  });

  it("正则表达式非法时返回失败结果", async () => {
    const result = await grepTool.execute({ pattern: "[", path: dir });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("正则表达式非法");
  });
});

describe("list_dir 工具（直连执行）", () => {
  it("目录排在文件之前，且目录与文件分别按名称排序", async () => {
    mkdirSync(join(dir, "z-dir"));
    mkdirSync(join(dir, "a-dir"));
    writeFileSync(join(dir, "z-file.txt"), "");
    writeFileSync(join(dir, "a-file.txt"), "");

    const result = await listDirTool.execute({ path: dir });

    expect(result).toEqual({
      ok: true,
      output: "a-dir/\nz-dir/\na-file.txt\nz-file.txt",
    });
  });

  it("空目录返回明确的空目录结果", async () => {
    const result = await listDirTool.execute({ path: dir });

    expect(result).toEqual({ ok: true, output: `目录为空: ${dir}` });
  });

  it("传入文件路径时返回失败结果", async () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "content");

    const result = await listDirTool.execute({ path: target });

    expect(result).toEqual({ ok: false, output: `不是目录: ${target}` });
  });
});

describe("文件工具异常与空结果边界", () => {
  it("glob 缺少有效 pattern 时返回失败", async () => {
    for (const args of [{}, { pattern: "  " }, { pattern: 123 }]) {
      const result = await globTool.execute(args);

      expect(result).toEqual({
        ok: false,
        output: "缺少必填参数 pattern（glob 模式）",
      });
    }
  });

  it("glob 未匹配到文件时返回明确空结果", async () => {
    writeFileSync(join(dir, "only.txt"), "content");

    const result = await globTool.execute({ pattern: "**/*.ts", path: dir });

    expect(result).toEqual({
      ok: true,
      output: "未匹配到文件（模式：**/*.ts）",
    });
  });

  it("glob 根路径为文件时返回失败", async () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "content");

    const result = await globTool.execute({ pattern: "*", path: target });

    expect(result).toEqual({ ok: false, output: `不是目录: ${target}` });
  });

  it("glob 根目录不存在时把遍历异常转为失败输出", async () => {
    const target = join(dir, "missing");

    const result = await globTool.execute({ pattern: "*", path: target });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("查找失败:");
    expect(result.output).toContain(`（根目录：${target}）`);
  });

  it("grep 缺少 pattern 时返回失败", async () => {
    for (const args of [{}, { pattern: "" }, { pattern: 123 }]) {
      const result = await grepTool.execute(args);

      expect(result).toEqual({
        ok: false,
        output: "缺少必填参数 pattern（正则表达式）",
      });
    }
  });

  it("grep 默认区分大小写，未命中时返回明确空结果", async () => {
    const target = join(dir, "case.txt");
    writeFileSync(target, "Alpha\nbeta", "utf8");

    const result = await grepTool.execute({ pattern: "alpha", path: target });

    expect(result).toEqual({
      ok: true,
      output: "未匹配到内容（正则：alpha）",
    });
  });

  it("grep 路径不存在时把搜索异常转为失败输出", async () => {
    const target = join(dir, "missing");

    const result = await grepTool.execute({ pattern: "hit", path: target });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("搜索失败:");
    expect(result.output).toContain(`（路径：${target}）`);
  });

  it("list_dir 路径不存在时把读取异常转为失败输出", async () => {
    const target = join(dir, "missing");

    const result = await listDirTool.execute({ path: target });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("列出目录失败:");
    expect(result.output).toContain(`（路径：${target}）`);
  });
});
