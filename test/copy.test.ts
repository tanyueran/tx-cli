import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyPath, resolveCopyTarget } from "../src/core/copy";

let root: string;

/**
 * 在临时根目录下写入一个文件，父目录不存在时自动创建
 * @param {string} relPath - 相对临时根目录的路径
 * @param {string | Buffer} content - 文件内容
 * @returns {string} 写入文件的绝对路径
 */
function writeFile(relPath: string, content: string | Buffer): string {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tx-cli-copy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveCopyTarget", () => {
  it("目标不存在时，直接作为目标路径", async () => {
    const src = writeFile("a.txt", "a");
    const dest = join(root, "b.txt");
    await expect(resolveCopyTarget(src, dest)).resolves.toBe(dest);
  });

  it("源为文件且目标是已存在目录时，复制进该目录", async () => {
    const src = writeFile("a.txt", "a");
    const dest = join(root, "out");
    mkdirSync(dest, { recursive: true });
    await expect(resolveCopyTarget(src, dest)).resolves.toBe(
      join(dest, "a.txt")
    );
  });

  it("源为目录且目标是已存在目录时，复制为 目标/源名", async () => {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const dest = join(root, "out");
    mkdirSync(dest, { recursive: true });
    await expect(resolveCopyTarget(src, dest)).resolves.toBe(
      join(dest, "src")
    );
  });

  it("源为目录但目标是已存在文件时，抛出 CliError", async () => {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const dest = writeFile("b.txt", "b");
    await expect(resolveCopyTarget(src, dest)).rejects.toThrow(
      "无法用目录覆盖已存在的文件"
    );
  });

  it("源路径不存在时，抛出 CliError", async () => {
    await expect(
      resolveCopyTarget(join(root, "nope"), join(root, "dest"))
    ).rejects.toThrow("源路径不存在");
  });
});

describe("copyPath", () => {
  it("复制单个文件，内容保持一致", async () => {
    const src = writeFile("a.txt", "hello");
    const dest = join(root, "b.txt");

    const result = await copyPath({ src, dest });

    expect(result.targetPath).toBe(dest);
    expect(result.copiedFiles).toBe(1);
    expect(readFileSync(dest, "utf-8")).toBe("hello");
  });

  it("二进制文件按字节复制，不受文本读取限制影响", async () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const src = writeFile("a.bin", buffer);
    const dest = join(root, "b.bin");

    await copyPath({ src, dest });

    expect(readFileSync(dest)).toEqual(buffer);
  });

  it("递归复制目录，保留目录结构", async () => {
    writeFile("src/a.txt", "a");
    writeFile("src/sub/b.txt", "b");
    const dest = join(root, "out");

    const result = await copyPath({ src: join(root, "src"), dest });

    expect(result.copiedFiles).toBe(2);
    expect(readFileSync(join(dest, "a.txt"), "utf-8")).toBe("a");
    expect(readFileSync(join(dest, "sub/b.txt"), "utf-8")).toBe("b");
  });

  it("--filter 按 glob 排除匹配的文件", async () => {
    writeFile("src/keep.txt", "keep");
    writeFile("src/drop.log", "drop");
    const dest = join(root, "out");

    const result = await copyPath({
      src: join(root, "src"),
      dest,
      filters: ["**/*.log"],
    });

    expect(result.copiedFiles).toBe(1);
    expect(result.skippedEntries).toBe(1);
    expect(existsSync(join(dest, "keep.txt"))).toBe(true);
    expect(existsSync(join(dest, "drop.log"))).toBe(false);
  });

  it("--filter 命中目录时整棵子树被跳过", async () => {
    writeFile("src/a.txt", "a");
    writeFile("src/node_modules/dep/index.js", "dep");
    const dest = join(root, "out");

    await copyPath({
      src: join(root, "src"),
      dest,
      filters: ["node_modules/**"],
    });

    expect(existsSync(join(dest, "a.txt"))).toBe(true);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });

  it("源与目标相同时，抛出 CliError", async () => {
    const src = writeFile("a.txt", "a");
    await expect(copyPath({ src, dest: src })).rejects.toThrow(
      "源路径与目标路径相同"
    );
  });

  it("目标位于源目录内部时，抛出 CliError", async () => {
    writeFile("src/a.txt", "a");
    const src = join(root, "src");
    const dest = join(src, "inner");

    await expect(copyPath({ src, dest })).rejects.toThrow(
      "目标路径不能位于源路径内部"
    );
  });

  it("目标已存在目录时，复制进该目录", async () => {
    writeFile("src/a.txt", "a");
    const dest = join(root, "out");
    mkdirSync(dest, { recursive: true });

    const result = await copyPath({ src: join(root, "src"), dest });

    expect(result.targetPath).toBe(join(dest, "src"));
    expect(existsSync(join(dest, "src/a.txt"))).toBe(true);
  });
});
