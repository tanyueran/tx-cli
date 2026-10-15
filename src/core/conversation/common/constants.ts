import type { ThinkingLevel } from "../../../types/llm";

/** 思考档位缺省值：配置与命令行均未指定时使用（chat、agent 等命令共用） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
