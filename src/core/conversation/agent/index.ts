/**
 * core/conversation/agent 模块的桶导出：agent 命令的任务执行能力入口
 * 说明：模块内部文件互相引用时，仍直接走具体文件
 */
export { runOneShotAgent } from "./one-shot";
export { runReplAgent } from "./repl";
