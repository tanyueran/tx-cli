import prompts from "prompts";
import { DefaultProjectName } from "../../constant/constant";
import { ProjectTemplateData } from "../../constant/template";
import pico from 'picocolors'
import path from "node:path";
import { processor } from "../../parse-template";
import { program } from "../var";

// -创建项目
program
  .command("create <project-name>")
  .description("创建项目")
  .option("-p, --project-name <projectName>", "项目名称")
  .action(async (_projectName: string) => {
    let projectName = _projectName || program.opts().projectName;
    console.log("项目名称：", projectName);
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
