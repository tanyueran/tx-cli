import { Command } from "commander";
import { getVersion } from "../shared/paths";
import { registerAddCommand } from "./command/add-command";
import { registerCreateCommand } from "./command/create-command";
import { registerServerCommand } from "./command/server-command";
import { registerGitRenameCommand } from "./command/git-rename-command";
import { registerCommitFixCommand } from "./command/commit-fix-command";

/** 命令注册器列表，help 中的展示顺序与此一致 */
const registrars = [
  registerCreateCommand,
  registerAddCommand,
  registerServerCommand,
  registerGitRenameCommand,
  registerCommitFixCommand,
];

/**
 * 创建并装配 commander 实例
 * @returns {Command} 已注册全部命令的 program
 */
export function createProgram(): Command {
  const program = new Command();
  program
    .name("tx cli")
    .description("一个简单CLI 工具")
    .version(getVersion());
  registrars.forEach((register) => register(program));
  return program;
}
