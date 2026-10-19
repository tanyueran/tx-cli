/**
 * core/tools 模块的桶导出：对外统一入口
 * 说明：模块内部文件互相引用（如 builtin 引用 types）时，仍直接走具体文件
 */
export { builtinTools } from "./builtin";
export { executeToolCall } from "./executor";
export type { Tool, ToolOutput, ToolResult } from "./types";
