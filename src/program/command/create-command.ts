import prompts from "prompts";
import { DefaultProjectName } from "../../constant/constant";
import { ProjectTemplateData } from "../../constant/template";
import pico from "picocolors";
import path from "node:path";
import { processor } from "../../parse-template";
import { program } from "../var";

// -创建项目
program
  .command("create [project-name]")
  .description("创建项目")
  .action(async (_projectName?: string) => {
    let projectName = _projectName;
    // 未传入项目名称时，让用户自己输入
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

    const selectedTemplate = ProjectTemplateData.find(
      (item) => item.value === response.template
    );
    // 用户中途取消选择时直接退出
    if (!selectedTemplate) {
      console.log(pico.yellow("未选择模板，已取消"));
      return;
    }

    console.log(pico.green("项目名称：" + projectName));
    console.log(pico.green("选择模板：" + selectedTemplate.label));

    const targetPath = path.resolve(process.cwd(), projectName!);
    const sourcePath = path.resolve(__dirname, selectedTemplate.path);

    const success = await processor({
      targetPath,
      sourcePath,
      templateData: {
        name: projectName,
      },
    });

    if (success) {
      console.log(pico.green("创建成功"));
      console.log(pico.green(`cd ./${projectName} && pnpm install`));
    }
  });
