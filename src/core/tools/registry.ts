import { CliError } from "../../shared/errors";
import { globTool } from "./builtin/glob";
import { grepTool } from "./builtin/grep";
import { listDirTool } from "./builtin/list-dir";
import { readFileTool } from "./builtin/read-file";
import { webSearchTool } from "./builtin/web-search";
import type { Tool } from "./types";

/**
 * 工具注册表：管理工具的注册与按名查找
 * 后续插件目录（~/.tx-cli/tools/）与 MCP 工具也汇入同一注册表
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * 注册工具
   * @param {Tool} tool - 工具实例
   * @returns {void}
   * @throws {CliError} 工具名重复时抛出
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new CliError(`工具 ${tool.name} 重复注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 按名称查找工具
   * @param {string} name - 工具名称
   * @returns {Tool | undefined} 命中的工具，未注册时为 undefined
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 列出全部已注册工具
   * @returns {Tool[]} 工具列表（注册顺序）
   */
  list(): Tool[] {
    return [...this.tools.values()];
  }
}

/**
 * 创建内置工具注册表：预注册随版本发布的内置工具
 * @returns {ToolRegistry} 已装载内置工具的注册表
 */
export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(webSearchTool);
  return registry;
}
