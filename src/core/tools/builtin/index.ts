import { editFileTool } from "./edit-file";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { listDirTool } from "./list-dir";
import { readFileTool } from "./read-file";
import { webSearchTool } from "./web-search";
import { writeFileTool } from "./write-file";
import { createTodoTool } from "./write-todos";
import type { TodoItem, TodoStatus, TodoToolHandle } from "./write-todos";
import type { Tool } from "../types";

export type { TodoItem, TodoStatus, TodoToolHandle };
export { createTodoTool };

/**
 * 写侧内置工具名清单：chat 只读模式在装配阶段按此集合剔除，
 * 使「只读」由代码强制，不依赖沙箱档位配置（workspace-write / sandbox 关闭时同样不可写）
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
]);

/**
 * 内置工具清单：随版本固定发布，不支持运行时动态注册（原插件目录方案已废弃）
 * 技能工具（load_skill）、任务清单（write_todos）与 MCP 工具由会话装配层（setupSkillContext）按需拼入工具列表；
 * write_file / edit_file 为写侧工具，agent 模式可用性由沙箱档位决定（read-only 档被边界拒绝），chat 模式直接剔除
 */
export const builtinTools: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  webSearchTool,
  writeFileTool,
  editFileTool,
];
