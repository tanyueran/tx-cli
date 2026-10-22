import { globTool } from "./glob";
import { grepTool } from "./grep";
import { listDirTool } from "./list-dir";
import { readFileTool } from "./read-file";
import { webSearchTool } from "./web-search";
import { createTodoTool } from "./write-todos";
import type { TodoItem, TodoStatus, TodoToolHandle } from "./write-todos";
import type { Tool } from "../types";

export type { TodoItem, TodoStatus, TodoToolHandle };
export { createTodoTool };

/**
 * 内置工具清单：随版本固定发布，不支持运行时动态注册（原插件目录方案已废弃）
 * 技能工具（load_skill）、任务清单（write_todos）与 MCP 工具由会话装配层（setupSkillContext）按需拼入工具列表
 */
export const builtinTools: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  webSearchTool,
];
