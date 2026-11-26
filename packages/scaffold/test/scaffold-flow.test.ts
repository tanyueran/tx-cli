import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
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
import { runScaffold } from "@tx-cli/scaffold/scaffold";
import { loadTemplates } from "@tx-cli/scaffold/scaffold/templates";
import type {
  ScaffoldOutput,
  ScaffoldPrompt,
  TemplateMeta,
} from "@tx-cli/scaffold/scaffold/types";

vi.mock("@tx-cli/scaffold/scaffold/templates", () => ({
  loadTemplates: vi.fn(),
}));

type PromptWithMocks = ScaffoldPrompt & {
  input: Mock;
  select: Mock;
  confirm: Mock;
};

type OutputWithMocks = ScaffoldOutput & {
  success: Mock;
  warn: Mock;
};

let tempDir: string;
let workingDir: string;
let templateRoot: string;
let prompt: PromptWithMocks;
let output: OutputWithMocks;

/**
 * 在临时目录中创建可供真实渲染使用的模板
 * @param {string} value - 模板标识，同时作为模板源目录名
 * @param {string} label - 模板在交互选项中的展示名称
 * @param {Record<string, string>} files - 相对文件路径到文件内容的映射
 * @returns {TemplateMeta} 指向临时模板源目录的模板元数据
 */
function createTemplate(
  value: string,
  label: string,
  files: Record<string, string>,
): TemplateMeta {
  const templatePath = join(templateRoot, value);
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = join(templatePath, fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return { label, value, path: templatePath };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tx-cli-scaffold-flow-"));
  workingDir = join(tempDir, "working");
  templateRoot = join(tempDir, "templates");
  mkdirSync(workingDir, { recursive: true });

  vi.spyOn(process, "cwd").mockReturnValue(workingDir);
  vi.mocked(loadTemplates).mockReset();
  prompt = {
    input: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
  };
  output = {
    success: vi.fn(),
    warn: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadTemplates).mockReset();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runScaffold 完整工作流", () => {
  it("trim 命令行名称，且不触发 input；单模板无需 select", async () => {
    const template = createTemplate("single", "单模板", {
      "package.json.hbs": '{"name":"{{name}}"}',
    });
    vi.mocked(loadTemplates).mockReturnValue([template]);

    const result = await runScaffold({
      name: "  demo-app  ",
      nameLabel: "项目名称",
      kind: "project",
      prompt,
      output,
    });

    const targetPath = join(workingDir, "demo-app");
    expect(result).toEqual({ name: "demo-app", targetPath });
    expect(loadTemplates).toHaveBeenCalledWith("project");
    expect(prompt.input).not.toHaveBeenCalled();
    expect(prompt.select).not.toHaveBeenCalled();
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(targetPath, "package.json"), "utf8")).toBe(
      '{"name":"demo-app"}',
    );
  });

  it("未传名称时通过 input 补录并用于生成", async () => {
    const template = createTemplate("single", "单模板", {
      "module.txt.hbs": "模块：{{name}}",
    });
    vi.mocked(loadTemplates).mockReturnValue([template]);
    prompt.input.mockResolvedValue("user-module");

    const result = await runScaffold({
      nameLabel: "模块名",
      kind: "module",
      prompt,
      output,
    });

    const targetPath = join(workingDir, "user-module");
    expect(prompt.input).toHaveBeenCalledTimes(1);
    expect(prompt.input).toHaveBeenCalledWith("请输入模块名");
    expect(result).toEqual({ name: "user-module", targetPath });
    expect(readFileSync(join(targetPath, "module.txt"), "utf8")).toBe(
      "模块：user-module",
    );
  });

  it("多模板传递完整 choices，并只生成用户选择的模板", async () => {
    const first = createTemplate("first", "第一个模板", {
      "choice.txt": "第一个模板",
      "first-only.txt": "不应混入生成结果",
    });
    const second = createTemplate("second", "第二个模板", {
      "choice.txt.hbs": "第二个模板：{{name}}",
      "second-only.txt": "已选择模板",
    });
    vi.mocked(loadTemplates).mockReturnValue([first, second]);
    prompt.select.mockResolvedValue(second);

    const result = await runScaffold({
      name: "multi-app",
      nameLabel: "项目名称",
      kind: "project",
      prompt,
      output,
    });

    expect(prompt.select).toHaveBeenCalledTimes(1);
    expect(prompt.select).toHaveBeenCalledWith("请选择模板", [
      { title: first.label, value: first },
      { title: second.label, value: second },
    ]);
    const targetPath = join(workingDir, "multi-app");
    expect(result).toEqual({ name: "multi-app", targetPath });
    expect(readFileSync(join(targetPath, "choice.txt"), "utf8")).toBe(
      "第二个模板：multi-app",
    );
    expect(existsSync(join(targetPath, "second-only.txt"))).toBe(true);
    expect(existsSync(join(targetPath, "first-only.txt"))).toBe(false);
  });

  it("目标已存在且拒绝覆盖时返回 null、输出警告并保持旧文件不变", async () => {
    const template = createTemplate("single", "单模板", {
      "new.txt": "新内容",
    });
    vi.mocked(loadTemplates).mockReturnValue([template]);
    prompt.confirm.mockResolvedValue(false);
    const targetPath = join(workingDir, "existing-app");
    const oldFilePath = join(targetPath, "old.txt");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(oldFilePath, "旧内容\n");

    const result = await runScaffold({
      name: "existing-app",
      nameLabel: "项目名称",
      kind: "project",
      prompt,
      output,
    });

    expect(result).toBeNull();
    expect(prompt.confirm).toHaveBeenCalledWith(
      `目标目录 ${targetPath} 已存在，继续将删除该目录下的全部内容，确认覆盖吗？`,
    );
    expect(output.warn).toHaveBeenCalledTimes(1);
    expect(output.warn).toHaveBeenCalledWith("已取消，未做任何修改");
    expect(readFileSync(oldFilePath, "utf8")).toBe("旧内容\n");
    expect(existsSync(join(targetPath, "new.txt"))).toBe(false);
  });

  it("确认覆盖后删除旧文件并渲染新内容", async () => {
    const template = createTemplate("single", "单模板", {
      "src/index.ts.hbs": "export const name = \"{{name}}\";",
    });
    vi.mocked(loadTemplates).mockReturnValue([template]);
    prompt.confirm.mockResolvedValue(true);
    const targetPath = join(workingDir, "overwrite-app");
    const oldFilePath = join(targetPath, "legacy/old.txt");
    mkdirSync(dirname(oldFilePath), { recursive: true });
    writeFileSync(oldFilePath, "待删除的旧内容");

    const result = await runScaffold({
      name: "overwrite-app",
      nameLabel: "项目名称",
      kind: "project",
      prompt,
      output,
    });

    expect(result).toEqual({ name: "overwrite-app", targetPath });
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(existsSync(oldFilePath)).toBe(false);
    expect(readFileSync(join(targetPath, "src/index.ts"), "utf8")).toBe(
      'export const name = "overwrite-app";',
    );
    expect(output.warn).not.toHaveBeenCalled();
  });
});
