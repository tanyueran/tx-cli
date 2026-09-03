import path from "node:path";
import { existsSync } from "node:fs";
import { removeSync } from "fs-extra";
import pico from "picocolors";
import { askConfirm, askSelect, askText } from "../../shared/prompt";
import { renderTemplate } from "./render";
import { loadTemplates } from "./templates";
import type { TemplateKind } from "../../types/template";

/**
 * 通用脚手架流程：确认名称 -> 选择模板 -> 确认覆盖 -> 生成文件
 * create（创建项目）与 add（添加模块）共用此流程，差异仅在文案与模板种类
 * @param {object} options - 流程参数
 * @param {string} [options.name] - 命令行已传入的名称，未传入时交互式询问
 * @param {string} options.nameLabel - 名称的业务称谓，如“项目名称”“模块名”
 * @param {TemplateKind} options.kind - 模板种类
 * @returns {Promise<{ name: string; targetPath: string } | null>} 生成成功时返回名称与目标路径，用户放弃覆盖时返回 null
 */
export async function runScaffold(options: {
  name?: string;
  nameLabel: string;
  kind: TemplateKind;
}): Promise<{ name: string; targetPath: string } | null> {
  const { nameLabel, kind } = options;

  const templates = loadTemplates(kind);
  const name = options.name?.trim() || (await askText(`请输入${nameLabel}`));

  // 只有一个模板时无需选择，直接使用
  const template =
    templates.length === 1
      ? templates[0]
      : await askSelect(
          "请选择模板",
          templates.map((item) => ({ title: item.label, value: item }))
        );

  console.log(pico.green(`${nameLabel}：${name}`));
  console.log(pico.green(`选择模板：${template.label}`));

  const targetPath = path.resolve(process.cwd(), name);

  // 目标目录已存在时，必须由用户确认才能覆盖，避免误删已有代码
  if (existsSync(targetPath)) {
    const overwrite = await askConfirm(
      `目标目录 ${targetPath} 已存在，继续将删除该目录下的全部内容，确认覆盖吗？`
    );
    if (!overwrite) {
      console.log(pico.yellow("已取消，未做任何修改"));
      return null;
    }
    removeSync(targetPath);
  }

  renderTemplate({
    sourcePath: template.path,
    targetPath,
    templateData: { name },
  });

  return { name, targetPath };
}
