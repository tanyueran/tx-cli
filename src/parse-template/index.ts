import {
  copyFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  existsSync,
  removeSync,
  mkdirSync,
  readFileSync,
} from "fs-extra";
import path from "node:path";
import Handlebars from "handlebars";
import prompts from "prompts";
import { toPascalCase } from "../utils/stringUtils";
import pico from "picocolors";

type TemplateDataType = {
  [key: string]: unknown;
};

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
 * 解析，并 copy 模板文件
 * @param {object} data - 解析参数
 * @param {string} data.targetPath - 生成的目标路径
 * @param {string} data.sourcePath - 模板源路径
 * @param {TemplateDataType} data.templateData - 注入模板的数据
 * @returns {void}
 */
function parseTemplate(data: {
  targetPath: string;
  sourcePath: string;
  templateData: TemplateDataType;
}) {
  const { targetPath, sourcePath, templateData } = data;

  // 源文件是目录
  if (statSync(sourcePath).isDirectory()) {
    // 创建目录
    mkdirSync(targetPath, { recursive: true });
    const items = readdirSync(sourcePath);
    items.forEach((item) => {
      parseTemplate({
        targetPath: path.join(targetPath, mapFileName(item)),
        sourcePath: path.join(sourcePath, item),
        templateData,
      });
    });
    // 源文件是文件
  } else {
    if (sourcePath.endsWith(".hbs")) {
      const templateContent = readFileSync(sourcePath);
      const compiledTemplate = Handlebars.compile<typeof templateData>(
        templateContent.toString()
      );
      const contentStr = compiledTemplate(templateData);
      writeFileSync(targetPath, contentStr);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

/**
 * 文件处理器：校验路径、处理已存在的目标目录，然后生成模板
 * @param {object} data - 处理参数
 * @param {string} data.targetPath - 生成的目标路径
 * @param {string} data.sourcePath - 模板源路径
 * @param {TemplateDataType} data.templateData - 注入模板的数据
 * @returns {Promise<boolean>} 生成成功返回 true，被用户取消或校验失败返回 false
 */
export async function processor(data: {
  targetPath: string;
  sourcePath: string;
  templateData: TemplateDataType;
}): Promise<boolean> {
  const { targetPath, sourcePath } = data;

  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    console.error(pico.red("源文件路径必须是一个已存在的目录"));
    return false;
  }

  // 目标目录已存在时，必须由用户确认才能覆盖，避免误删已有代码
  if (existsSync(targetPath)) {
    const { overwrite } = await prompts({
      type: "confirm",
      name: "overwrite",
      message: `目标目录 ${targetPath} 已存在，继续将删除该目录下的全部内容，确认覆盖吗？`,
      initial: false,
    });
    if (!overwrite) {
      console.log(pico.yellow("已取消，未做任何修改"));
      return false;
    }
    removeSync(targetPath);
  }
  mkdirSync(targetPath, { recursive: true });

  parseTemplate(data);
  return true;
}
