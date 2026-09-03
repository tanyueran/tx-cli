import { describe, it, expect } from "vitest";
import { mapFileName } from "../src/parse-template/index";

describe("mapFileName", () => {
  it("_gitignore 还原为 .gitignore", () => {
    expect(mapFileName("_gitignore")).toBe(".gitignore");
  });

  it("剥离 .hbs 后缀", () => {
    expect(mapFileName("package.json.hbs")).toBe("package.json");
  });

  it("普通文件名保持不变", () => {
    expect(mapFileName("vite.config.ts")).toBe("vite.config.ts");
  });

  it("只剥离末尾的 .hbs，不影响文件名中间的内容", () => {
    expect(mapFileName("index.hbs.vue")).toBe("index.hbs.vue");
  });

  it("同时处理 _gitignore 与 .hbs", () => {
    expect(mapFileName("_gitignore.hbs")).toBe("_gitignore");
  });
});