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
const path = require("node:path");
import { compile, registerHelper } from "handlebars";
import { toPascalCase } from "../utils/stringUtils";

type TemplateDataType = {
  [key: string]: unknown;
};

registerHelper("toPascalCase", function (str: string) {
  return toPascalCase(str);
});

/**
 * 解析，并 copy 模板文件
 * @param data
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
    let items = readdirSync(sourcePath);
    items.forEach((item) => {
      parseTemplate({
        targetPath: path.join(targetPath, item),
        sourcePath: path.join(sourcePath, item),
        templateData,
      });
    });
    // 源文件是文件
  } else {
    if (sourcePath.endsWith(".hbs")) {
      const templateContent = readFileSync(sourcePath);
      const compiledTemplate = compile<typeof templateData>(
        templateContent.toString()
      );
      const contentStr = compiledTemplate(templateData);
      writeFileSync(targetPath.replace(".hbs", ""), contentStr);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

/**
 * 文件处理器
 * @param data
 */
export function processor(data: {
  targetPath: string;
  sourcePath: string;
  templateData: TemplateDataType;
}) {
  const { targetPath, sourcePath } = data;

  if (!statSync(sourcePath).isDirectory()) {
    throw new Error("源文件路劲必须是一个目录");
  }

  // 旧目录存在，则直接删除
  if (existsSync(targetPath)) {
    removeSync(targetPath);
  }
  mkdirSync(targetPath, { recursive: true });

  parseTemplate(data);
}
