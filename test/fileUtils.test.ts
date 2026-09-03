import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsWithExactCase } from "../src/utils/fileUtils";

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