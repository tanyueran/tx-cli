import prompts from "prompts";
import { DefaultModuleName } from "../../constant/constant";
import { ModuleTemplateData } from "../../constant/template";
import pico from "picocolors";
import path from "node:path";
import { processor } from "../../parse-template";
import { program } from "../var";

// -添加模块
program
  .command("add [module-name]")
  .description("添加模块")
  .action(async (_moduleName?: string) => {
    let moduleName = _moduleName;
    // 未传入模块名称时，让用户自己输入
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

    const selectedTemplate = ModuleTemplateData.find(
      (item) => item.value === response.template
    );
    // 用户中途取消选择时直接退出
    if (!selectedTemplate) {
      console.log(pico.yellow("未选择模板，已取消"));
      return;
    }

    console.log(pico.green("模块名称：" + moduleName));
    console.log(pico.green("选择模板：" + selectedTemplate.label));

    const targetPath = path.resolve(process.cwd(), moduleName!);
    const sourcePath = path.resolve(__dirname, selectedTemplate.path);

    const success = await processor({
      targetPath,
      sourcePath,
      templateData: {
        name: moduleName,
      },
    });

    if (success) {
      console.log(pico.green(`模块已生成：${targetPath}`));
    }
  });
