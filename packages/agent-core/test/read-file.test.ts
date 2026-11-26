import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "@tanyueran/agent-core/tools/builtin/read-file";

/** 每个用例独立使用的临时目录 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-read-file-tool-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("read_file 工具（直连执行）", () => {
  it("未指定行范围时返回完整文本", async () => {
    const target = join(dir, "full.txt");
    writeFileSync(target, "第一行\n第二行\n第三行", "utf8");

    const result = await readFileTool.execute({ path: target });

    expect(result).toEqual({ ok: true, output: "第一行\n第二行\n第三行" });
  });

  it("按 offset/limit 返回指定行，并给出下一段的续读位置", async () => {
    const target = join(dir, "range.txt");
    writeFileSync(target, "第一行\n第二行\n第三行\n第四行", "utf8");

    const result = await readFileTool.execute({
      path: target,
      offset: 2,
      limit: 2,
    });

    expect(result).toEqual({
      ok: true,
      output: "第二行\n第三行\n\n（第 2-3 行，共 4 行；续读请设 offset=4）",
    });
  });

  it("仅指定 limit 时从首行开始读取", async () => {
    const target = join(dir, "limit.txt");
    writeFileSync(target, "第一行\n第二行\n第三行", "utf8");

    const result = await readFileTool.execute({ path: target, limit: 2 });

    expect(result).toEqual({
      ok: true,
      output: "第一行\n第二行\n\n（第 1-2 行，共 3 行；续读请设 offset=3）",
    });
  });

  it("读取到文件末尾时不附加续读提示", async () => {
    const target = join(dir, "tail.txt");
    writeFileSync(target, "第一行\n第二行\n第三行", "utf8");

    const result = await readFileTool.execute({ path: target, offset: 3 });

    expect(result).toEqual({
      ok: true,
      output: "第三行\n\n（第 3-3 行，共 3 行）",
    });
  });

  it("offset 超出文件行数时返回明确失败说明", async () => {
    const target = join(dir, "short.txt");
    writeFileSync(target, "第一行\n第二行", "utf8");

    const result = await readFileTool.execute({ path: target, offset: 3 });

    expect(result).toEqual({
      ok: false,
      output: `offset（3）超出文件行数（共 2 行，路径：${target}）`,
    });
  });

  it("offset 与 limit 必须是大于等于 1 的整数", async () => {
    const target = join(dir, "params.txt");
    writeFileSync(target, "内容", "utf8");

    for (const field of ["offset", "limit"]) {
      for (const value of [0, 1.5, "2"]) {
        const result = await readFileTool.execute({
          path: target,
          [field]: value,
        });

        expect(result).toEqual({
          ok: false,
          output: `参数 ${field} 必须是 >=1 的整数（按行计数，从 1 开始）`,
        });
      }
    }
  });

  it("path 缺失、空白或类型错误时返回失败", async () => {
    for (const args of [{}, { path: "  " }, { path: 123 }]) {
      const result = await readFileTool.execute(args);

      expect(result).toEqual({
        ok: false,
        output: "缺少必填参数 path（文件路径）",
      });
    }
  });

  it("文件不存在时把读取异常转为失败输出", async () => {
    const target = join(dir, "missing.txt");

    const result = await readFileTool.execute({ path: target });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("读取文件失败:");
    expect(result.output).toContain(`（路径：${target}）`);
  });

  it("二进制文件返回失败而不是输出乱码", async () => {
    const target = join(dir, "binary.bin");
    writeFileSync(target, Buffer.from([0x41, 0x00, 0x42]));

    const result = await readFileTool.execute({ path: target });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("二进制文件不支持读取");
    expect(result.output).toContain(`（路径：${target}）`);
  });
});
