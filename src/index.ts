import { Command } from "commander";
import prompts from "prompts";
import * as pkg from "../package.json";
const pico = require("picocolors");
import path from "node:path";
import { ProjectTemplateData, ModuleTemplateData } from "./constant/template";
import { DefaultModuleName, DefaultProjectName } from "./constant/constant";
import { processor } from "./processor/index";

const program = new Command();

program.name("tx cli").description("一个简单CLI 工具").version(pkg.version);

// 定义命令后面的options
program
  .option("-m, --module-name <moduleName>", "模块名称")
  .option("-p, --project-name <projectName>", "项目名称");

/**
 * 定义命令
 * tx create <project-name> => 选择模板
 * tx add <module-name> =》选择模板
 */

// -创建项目
program
  .command("create")
  .description("创建项目")
  .action(async () => {
    let projectName = program.opts().projectName;
    // option 中没有携带模块名称时，让用户自己在输入
    if (!projectName) {
      const result = await prompts([
        {
          type: "text",
          name: "name",
          message: "请输入项目名称",
        },
      ]);
      projectName = result.name ? result.name : DefaultProjectName;
    }
    // prompts
    const response = await prompts([
      {
        type: "select",
        name: "template",
        message: "请选择模板",
        choices: ProjectTemplateData.map((item) => {
          return {
            title: item.label,
            value: item.value,
          };
        }),
      },
    ]);

    console.log(pico.green("项目名称：" + response.template));
    console.log(pico.green("选择模板：" + projectName));

    const selectedTemplate = ProjectTemplateData.find(
      (item) => item.value === response.template
    );
    const targetPath = path.resolve(process.cwd(), projectName);
    const sourcePath = path.resolve(__dirname, selectedTemplate!.path);

    processor({
      targetPath,
      sourcePath,
      templateData: {
        name: projectName,
      },
    });
    console.log(pico.green("创建成功"));
    console.log(pico.green(`cd ./${projectName} && pnpm install`));
  });

// -添加模块
program
  .command("add")
  .description("添加模块")
  .action(async () => {
    let moduleName = program.opts().moduleName;
    // option 中没有携带模块名称时，让用户自己在输入
    if (!moduleName) {
      const result = await prompts([
        {
          type: "text",
          name: "name",
          message: "请输入模块名",
        },
      ]);
      moduleName = result.name ? result.name : DefaultModuleName;
    }
    // 询问创建的 模板等
    // prompts
    const response = await prompts([
      {
        type: "select",
        name: "template",
        message: "请选择模板",
        choices: ModuleTemplateData.map((item) => ({
          title: item.label,
          value: item.value,
        })),
      },
    ]);
    console.log(pico.green("模板名称：" + moduleName));
    console.log(pico.green("选择模板：" + response.template));

    const selectedTemplate = ModuleTemplateData.find(
      (item) => item.value === response.template
    );
    const targetPath = path.resolve(process.cwd(), moduleName);
    const sourcePath = path.resolve(__dirname, selectedTemplate!.path);

    processor({
      targetPath,
      sourcePath,
      templateData: {
        name: moduleName,
      },
    });

    // TODO
    // 接入AI，通过AI去实现，你的描述表达的案例
  });

export function start() {
  program.parse(process.argv);
}
