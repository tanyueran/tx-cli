import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapFileName, renderTemplate } from "../src/core/scaffold/render";
import { CliError } from "../src/shared/errors";

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

describe("renderTemplate", () => {
  let dir: string;
  let source: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tx-cli-render-"));
    source = join(dir, "source");
    target = join(dir, "target");
    mkdirSync(source);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("渲染 .hbs 模板并注入数据，同时剥离后缀", () => {
    writeFileSync(join(source, "readme.md.hbs"), "# {{name}}");

    renderTemplate({
      sourcePath: source,
      targetPath: target,
      templateData: { name: "my-app" },
    });

    expect(readFileSync(join(target, "readme.md"), "utf-8")).toBe("# my-app");
  });

  it("非 .hbs 文件原样拷贝，_gitignore 被还原", () => {
    writeFileSync(join(source, "_gitignore"), "node_modules\n");

    renderTemplate({
      sourcePath: source,
      targetPath: target,
      templateData: {},
    });

    expect(readFileSync(join(target, ".gitignore"), "utf-8")).toBe(
      "node_modules\n"
    );
  });

  it("支持 toPascalCase helper", () => {
    writeFileSync(join(source, "index.ts.hbs"), "export class {{toPascalCase name}} {}");

    renderTemplate({
      sourcePath: source,
      targetPath: target,
      templateData: { name: "user-profile" },
    });

    expect(readFileSync(join(target, "index.ts"), "utf-8")).toBe(
      "export class UserProfile {}"
    );
  });

  it("递归处理子目录", () => {
    mkdirSync(join(source, "src"));
    writeFileSync(join(source, "src", "main.ts.hbs"), "// {{name}}");

    renderTemplate({
      sourcePath: source,
      targetPath: target,
      templateData: { name: "demo" },
    });

    expect(readFileSync(join(target, "src", "main.ts"), "utf-8")).toBe("// demo");
  });

  it("源路径不存在时抛出 CliError", () => {
    expect(() =>
      renderTemplate({
        sourcePath: join(dir, "nope"),
        targetPath: target,
        templateData: {},
      })
    ).toThrow(CliError);
  });
});
