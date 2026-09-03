import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveTemplatePath } from "../../shared/paths";
import { CliError } from "../../shared/errors";
import { TEMPLATE_MANIFEST } from "./render";
import type { TemplateKind, TemplateMeta } from "../../types/template";

/**
 * 递归收集指定目录下所有含 template.json 的模板目录
 * @param {string} dir - 当前扫描的绝对路径
 * @param {string} root - 模板种类的根目录绝对路径，用于计算相对路径
 * @param {TemplateMeta[]} result - 收集结果
 * @returns {void}
 */
function collect(dir: string, root: string, result: TemplateMeta[]): void {
  const manifestPath = join(dir, TEMPLATE_MANIFEST);

  if (existsSync(manifestPath)) {
    let label: unknown;
    try {
      label = JSON.parse(readFileSync(manifestPath, "utf-8")).label;
    } catch (err) {
      throw new CliError(
        `模板配置解析失败 ${manifestPath}：${(err as Error).message}`
      );
    }
    if (typeof label !== "string" || !label.trim()) {
      throw new CliError(`模板配置缺少有效的 label 字段：${manifestPath}`);
    }
    // 相对根目录的路径天然唯一，直接作为模板标识，无需再维护枚举
    const value = relative(root, dir).split(/[\\/]/).join("/");
    result.push({ label, value, path: dir });
    // 模板内部不再嵌套模板，命中后停止向下扫描
    return;
  }

  for (const item of readdirSync(dir)) {
    const child = join(dir, item);
    if (statSync(child).isDirectory()) {
      collect(child, root, result);
    }
  }
}

/**
 * 加载指定种类下的全部可用模板
 * 以目录结构为唯一事实来源：新增模板只需放入目录并附带 template.json，无需改动代码
 * @param {TemplateKind} kind - 模板种类，project 或 module
 * @returns {TemplateMeta[]} 按名称排序的模板列表
 */
export function loadTemplates(kind: TemplateKind): TemplateMeta[] {
  const root = resolveTemplatePath(kind);
  if (!existsSync(root)) {
    throw new CliError(`模板目录不存在：${root}`);
  }

  const result: TemplateMeta[] = [];
  collect(root, root, result);

  if (result.length === 0) {
    throw new CliError(`${kind} 下没有可用的模板`);
  }

  return result.sort((a, b) => a.value.localeCompare(b.value));
}
