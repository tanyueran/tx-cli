import {
  copyFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "fs-extra";
import path from "node:path";
import Handlebars from "handlebars";
import { toPascalCase } from "../../shared/string";
import { CliError } from "../../shared/errors";
import type { TemplateData } from "./types";

/** 模板的自描述文件名，含有该文件的目录即被视为一个模板 */
export const TEMPLATE_MANIFEST = "template.json";

Handlebars.registerHelper("toPascalCase", function (str: string) {
  return toPascalCase(str);
});

/**
 * 将模板中的文件名映射为生成后的真实文件名
 * 说明：npm 发包时会强制排除 .gitignore，所以模板里用 _gitignore 占位，生成时再还原
 * @param {string} name - 模板中的文件名（不含目录）
 * @returns {string} 生成到目标目录后的文件名
 */
export function mapFileName(name: string): string {
  let result = name === "_gitignore" ? ".gitignore" : name;
  if (result.endsWith(".hbs")) {
    result = result.slice(0, -".hbs".length);
  }
  return result;
}

/**
 * 递归渲染并拷贝模板文件
 * @param {string} sourcePath - 模板源路径
 * @param {string} targetPath - 生成的目标路径
 * @param {TemplateData} templateData - 注入模板的数据
 * @returns {void}
 */
function copyRecursively(
  sourcePath: string,
  targetPath: string,
  templateData: TemplateData
): void {
  if (statSync(sourcePath).isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    readdirSync(sourcePath).forEach((item) => {
      // template.json 是模板自身的配置，不属于生成内容
      if (item === TEMPLATE_MANIFEST) {
        return;
      }
      copyRecursively(
        path.join(sourcePath, item),
        path.join(targetPath, mapFileName(item)),
        templateData
      );
    });
    return;
  }

  if (sourcePath.endsWith(".hbs")) {
    const compiled = Handlebars.compile(readFileSync(sourcePath).toString());
    writeFileSync(targetPath, compiled(templateData));
  } else {
    copyFileSync(sourcePath, targetPath);
  }
}

/**
 * 把模板目录渲染到目标目录
 * 纯执行逻辑：不涉及任何用户交互，目标目录的覆盖决策由调用方负责
 * @param {object} data - 渲染参数
 * @param {string} data.sourcePath - 模板源路径，必须是已存在的目录
 * @param {string} data.targetPath - 生成的目标路径
 * @param {TemplateData} data.templateData - 注入模板的数据
 * @returns {void}
 */
export function renderTemplate(data: {
  sourcePath: string;
  targetPath: string;
  templateData: TemplateData;
}): void {
  const { sourcePath, targetPath, templateData } = data;

  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new CliError(`模板路径不是一个已存在的目录：${sourcePath}`);
  }

  mkdirSync(targetPath, { recursive: true });
  copyRecursively(sourcePath, targetPath, templateData);
}
