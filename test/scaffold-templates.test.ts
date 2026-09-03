import { describe, it, expect } from "vitest";
import { loadTemplates } from "../src/core/scaffold/templates";

describe("loadTemplates", () => {
  it("扫描出 project 模板，且不含未注册的空目录", () => {
    const templates = loadTemplates("project");

    expect(templates.length).toBeGreaterThan(0);
    expect(templates.map((t) => t.value)).toContain("vue/vite-vue-ts");
  });

  it("扫描出 module 模板", () => {
    const templates = loadTemplates("module");

    expect(templates.map((t) => t.value)).toContain("vue/vue-ts-empty");
  });

  it("label 来自 template.json，且 path 为存在的绝对路径", () => {
    const [template] = loadTemplates("project");

    expect(template.label).toBeTruthy();
    expect(template.path).toMatch(/^\//);
  });

  it("value 统一使用正斜杠作为分隔符", () => {
    for (const template of loadTemplates("project")) {
      expect(template.value).not.toContain("\\");
    }
  });
});
