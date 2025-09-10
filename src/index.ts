import { program } from "./program";

// 定义命令后面的options
program
  .option("-m, --module-name <moduleName>", "模块名称")
  .option("-p, --project-name <projectName>", "项目名称");

/**
 * 定义命令
 * tx create <project-name> => 选择模板
 * tx add <module-name> =》选择模板
 */



export function start() {
  program.parse(process.argv);
}
