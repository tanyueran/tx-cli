import type { ConversationModeConfig } from "../common/mode";

/** agent 命令的基础 system 提示词（人设），经 setupSkillContext 组装技能清单后下发 */
export const SYSTEM_PROMPT =
  "你是 tx-cli 的任务执行 Agent。收到任务后自主拆解步骤，按需使用工具（读写文件、" +
  "执行 bash 命令、检索、MCP）逐步完成；删除、覆盖、推送等高危操作先向用户确认；" +
  "对 3 步以上的任务，先调用 write_todos 建立任务清单，此后每完成一项更新一次清单" +
  "（全量替换，同一时刻仅一项 in_progress），简单任务不必使用；" +
  "完成后简要汇报：做了什么、改了哪些文件、遗留什么风险。";

/** agent 模式配置：任务执行人设，全量工具带（bash 跟随 sandboxCli/配置装配，write_todos 开启），任务拆解步骤多故放宽到 20 轮 */
export const AGENT_MODE: ConversationModeConfig = {
  basePrompt: SYSTEM_PROMPT,
  modeLabel: "Agent 模式",
  maxIterations: 20,
  todosEnabled: true,
};
