import path from "node:path";
import { existsSync } from "node:fs";
import { removeSync } from "fs-extra";
import { renderTemplate } from "./render";
import { loadTemplates } from "./templates";
import type { TemplateKind, ScaffoldPrompt, ScaffoldOutput } from "./types";

/**
 * 通用脚手架流程：确认名称 -> 选择模板 -> 确认覆盖 -> 生成文件
 * create（创建项目）与 add（添加模块）共用此流程，差异仅在文案与模板种类
 * @param {object} options - 流程参数
 * @param {string} [options.name] - 命令行已传入的名称（可为相对路径），未传入时交互式询问
 * @param {string} options.nameLabel - 名称的业务称谓，如“项目名称”“模块名”
 * @param {TemplateKind} options.kind - 模板种类
 * @param {ScaffoldPrompt} options.prompt - 交互提示通道（问询出口）
 * @param {ScaffoldOutput} options.output - 语义化输出通道（提示与结果输出出口）
 * @param {string} [options.cwd] - 生成目录的基准目录，缺省为当前工作目录
 * @returns {Promise<{ name: string; targetPath: string } | null>} 生成成功时返回名称与目标路径，用户放弃覆盖时返回 null
 */
export async function runScaffold(options: {
  name?: string;
  nameLabel: string;
  kind: TemplateKind;
  prompt: ScaffoldPrompt;
  output: ScaffoldOutput;
  cwd?: string;
}): Promise<{ name: string; targetPath: string } | null> {
  const { nameLabel, kind, prompt, output } = options;

  const templates = loadTemplates(kind);
  const name = options.name?.trim() || (await prompt.input(`请输入${nameLabel}`));
  // 名称允许是路径（如 ./abc/aaa），模板内使用的名称只取路径最后一段（aaa）
  const baseName = path.basename(name);

  // 只有一个模板时无需选择，直接使用
  const choices = templates.map((item) => ({ title: item.label, value: item }));
  const template =
    templates.length === 1
      ? templates[0]
      : ((await prompt.select("请选择模板", choices)) as (typeof templates)[number]);

  output.success(`${nameLabel}：${baseName}`);
  output.success(`选择模板：${template.label}`);

  // 相对路径以调用方指定的基准目录为准（命令行执行目录），未指定时回退到当前工作目录
  const targetPath = path.resolve(options.cwd ?? process.cwd(), name);

  // 目标目录已存在时，必须由用户确认才能覆盖，避免误删已有代码
  if (existsSync(targetPath)) {
    const overwrite = await prompt.confirm(
      `目标目录 ${targetPath} 已存在，继续将删除该目录下的全部内容，确认覆盖吗？`,
    );
    if (!overwrite) {
      output.warn("已取消，未做任何修改");
      return null;
    }
    removeSync(targetPath);
  }

  renderTemplate({
    sourcePath: template.path,
    targetPath,
    templateData: { name: baseName },
  });

  return { name, targetPath };
}

export { mapFileName, renderTemplate } from "./render";
export { loadTemplates } from "./templates";
export type { TemplateKind, ScaffoldPrompt, ScaffoldOutput } from "./types";
