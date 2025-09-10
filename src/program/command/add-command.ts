import prompts from "prompts";
import { DefaultModuleName } from "../../constant/constant";
import { ModuleTemplateData } from "../../constant/template";
const pico = require("picocolors");
import path from "node:path";
import { processor } from "../../parse-template";
import { program } from "../var";

// -添加模块
program
  .command("add <module-name>")
  .description("添加模块")
  .action(async (_moduleName: string) => {
    console.log("_moduleName:", _moduleName);
    let moduleName = _moduleName || program.opts().moduleName;
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
