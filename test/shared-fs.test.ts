import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsWithExactCase, sliceLines } from "../src/shared/fs";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-cli-test-"));
  writeFileSync(join(dir, "User.ts"), "");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("existsWithExactCase", () => {
  it("大小写完全一致时返回 true", () => {
    expect(existsWithExactCase(join(dir, "User.ts"))).toBe(true);
  });

  it("大小写不一致时返回 false（即使文件系统大小写不敏感）", () => {
    expect(existsWithExactCase(join(dir, "user.ts"))).toBe(false);
  });

  it("文件不存在时返回 false", () => {
    expect(existsWithExactCase(join(dir, "nope.ts"))).toBe(false);
  });
});

describe("sliceLines", () => {
  it("按 offset/limit 截取并返回行号区间", () => {
    const slice = sliceLines("a\nb\nc\nd", 2, 2);

    expect(slice.text).toBe("b\nc");
    expect(slice).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4 });
  });

  it("未给 limit 时读到文末", () => {
    const slice = sliceLines("a\nb\nc", 2);

    expect(slice.text).toBe("b\nc");
    expect(slice.endLine).toBe(3);
  });

  it("offset 越界时收敛到末行而非抛错", () => {
    const slice = sliceLines("a\nb", 9);

    expect(slice.startLine).toBe(2);
    expect(slice.endLine).toBe(2);
    expect(slice.text).toBe("b");
  });
});