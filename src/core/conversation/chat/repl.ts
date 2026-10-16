import pico from "picocolors";
import {
  createResponsesTurn,
  createStreamRenderer,
  createToolCallLogger,
  resolveThinkingLevel,
  runAgentLoop,
  setupSkillContext,
  warnThinkingFallback,
} from "../common";
import { printWarnings } from "../../../shared/warnings";
import {
  parseThinkingLevel,
  resolveResponsesThinkingFields,
  resolveThinkingStyle,
  THINKING_LEVELS,
} from "../../llm";
import { connectMcpServers } from "../../mcp";
import type { Tool } from "../../tools";
import { CancelError, CliError } from "../../../shared/errors";
import { askText } from "../../../shared/prompt";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../../types/llm";
import { SYSTEM_PROMPT } from "./constants";

/** REPL 会话上下文：会话期间不变的依赖打包，避免逐参数透传 */
interface ReplSession {
  /** LLM 接入配置 */
  config: LlmConfig;
  /** 思考协议风格（会话内不变，启动时解析一次） */
  style: ThinkingStyle;
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 本会话可用的工具列表（内置 + load_skill） */
  tools: Tool[];
}

/**
 * 执行多轮对话的一轮：Responses API 无状态模式 + agentic loop，工具调用开启（内置 read_file 等）
 * store=false：服务端不留存会话，历史由本地维护并每轮全量发送，跨轮经共享 history 数组衔接；
 * 深度思考内容以暗色流式输出（模型未返回时不输出），instructions 每轮重传
 * @param {ReplSession} session - 会话上下文（配置、协议风格、提示词、工具列表）
 * @param {ResponseHistoryItem[]} history - 跨轮共享的对话历史（本函数向其追加内容）
 * @param {string} input - 本轮用户输入
 * @param {ThinkingLevel} thinkingLevel - 本轮思考档位（/think 切换后下一轮使用新档位）
 * @returns {Promise<void>}
 */
async function runReplTurn(
  session: ReplSession,
  history: ResponseHistoryItem[],
  input: string,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  const renderer = createStreamRenderer();
  const runTurn = createResponsesTurn({
    config: session.config,
    input,
    history,
    instructions: session.systemPrompt,
    extraBody: resolveResponsesThinkingFields(
      thinkingLevel,
      session.style,
      session.config.thinkingEffortMap,
    ),
    tools: session.tools,
    onDelta: renderer.onDelta,
    onReasoningDelta: renderer.onReasoningDelta,
  });
  await runAgentLoop({
    runTurn,
    tools: session.tools,
    onToolCall: createToolCallLogger(renderer),
  });
  process.stdout.write("\n\n");
}

/**
 * 打印思考档位切换/设置结果与服务能力折算提示
 * @param {ThinkingLevel} level - 目标档位
 * @param {ThinkingStyle} style - 思考协议风格
 * @returns {void}
 */
function printThinkingNotice(level: ThinkingLevel, style: ThinkingStyle): void {
  // none 风格的警告已含档位信息，不重复打印档位行
  if (style !== "none") {
    console.log(pico.cyan(`思考档位：${level}`));
  }
  warnThinkingFallback(level, style);
}

/**
 * 多轮对话模式（REPL）：循环提问，直到用户输入 exit/quit 或按 Ctrl+C 退出
 * 基于 Responses API（无状态模式）+ agentic loop：历史由本地维护、每轮全量发送，
 * 模型可在任意一轮发起工具调用（read_file 等），与单次问答模式能力一致
 * 支持内联命令 /think：无参查看当前思考档位，带参切换（如 /think high，下一轮生效）
 * 支持内联命令 /skills：列出可用技能及来源
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @returns {Promise<void>}
 */
export async function runReplChat(
  config: LlmConfig,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
): Promise<void> {
  // 初始档位由 /think 在会话内切换（见 runReplSession）
  const currentLevel = resolveThinkingLevel(thinkingLevel, config);
  const style = resolveThinkingStyle(config);
  const { manager, tools: mcpTools } = await connectMcpServers(mcpEnabled);
  try {
    await runReplSession(config, style, currentLevel, mcpTools);
  } finally {
    // MCP 连接随会话结束关闭（含异常路径），stdio 子进程随之退出
    await manager?.closeAll();
  }
}

/**
 * REPL 主循环：装配会话上下文并循环处理用户输入，MCP 生命周期由调用方管理
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingStyle} style - 思考协议风格
 * @param {ThinkingLevel} currentLevel - 初始思考档位
 * @param {Tool[]} mcpTools - MCP 工具列表（可为空）
 * @returns {Promise<void>}
 */
async function runReplSession(
  config: LlmConfig,
  style: ThinkingStyle,
  currentLevel: ThinkingLevel,
  mcpTools: Tool[],
): Promise<void> {
  const { systemPrompt, tools, catalog, warnings } = setupSkillContext(
    SYSTEM_PROMPT,
    mcpTools,
  );
  printWarnings(warnings);
  const skillNote = catalog.size > 0 ? `，已发现 ${catalog.size} 个技能` : "";
  const mcpNote =
    mcpTools.length > 0 ? `，已连接 MCP 工具 ${mcpTools.length} 个` : "";
  console.log(
    pico.green(
      `已连接模型 ${config.model}，思考档位 ${currentLevel}，支持工具调用${skillNote}${mcpNote}，输入问题开始对话，输入 exit 或按 Ctrl+C 退出`,
    ),
  );
  const hints = [
    `/think 查看思考档位，/think <${THINKING_LEVELS.join("|")}> 切换`,
  ];
  if (catalog.size > 0) {
    hints.push("/skills 查看可用技能");
  }
  console.log(pico.cyan(`提示：${hints.join("；")}`));
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(currentLevel, style);
  const session: ReplSession = { config, style, systemPrompt, tools };
  // 本地维护的对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积
  const history: ResponseHistoryItem[] = [];

  for (;;) {
    let input: string;
    try {
      // askText 已保证返回值去除首尾空格且非空，命令匹配无需再 trim
      input = await askText(pico.green("你 > "));
    } catch (err) {
      // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
      if (err instanceof CancelError) {
        console.log(pico.yellow("已退出对话"));
        return;
      }
      throw err;
    }

    const lower = input.toLowerCase();
    if (lower === "exit" || lower === "quit") {
      console.log(pico.yellow("已退出对话"));
      return;
    }

    // 内联命令 /skills：列出可用技能及来源，便于确认模型可加载的手册清单
    if (lower === "/skills") {
      if (catalog.size === 0) {
        console.log(
          pico.yellow(
            "未发现可用技能（扫描目录：~/.tx-cli/skills、./.tx-cli/skills）",
          ),
        );
      } else {
        for (const skill of catalog.list()) {
          const source = skill.source === "project" ? "项目级" : "用户级";
          console.log(
            `${pico.cyan(skill.name)}（${source}）${skill.description}`,
          );
        }
      }
      continue;
    }

    // 内联命令 /think：查看或切换思考档位，非法值提示后保留原档位，不退出会话
    // 精确匹配 /think 或 /think <档位>：/thinking 等前缀相似的输入应当作普通问题发给模型
    if (lower === "/think" || lower.startsWith("/think ")) {
      const arg = input.slice("/think".length).trim();
      if (!arg) {
        printThinkingNotice(currentLevel, style);
        continue;
      }
      try {
        currentLevel = parseThinkingLevel(arg) ?? currentLevel;
        printThinkingNotice(currentLevel, style);
      } catch (err) {
        if (!(err instanceof CliError)) {
          throw err;
        }
        console.error(pico.red(err.message));
      }
      continue;
    }

    try {
      await runReplTurn(session, history, input, currentLevel);
    } catch (err) {
      // 仅吞可预期的业务错误（网络、接口报错）；未预期错误仍上抛，避免代码 bug 被无限循环掩盖
      if (!(err instanceof CliError)) {
        throw err;
      }
      // 换行避免错误提示接在残缺的流式输出之后
      process.stdout.write("\n");
      console.error(pico.red(err.message));
    }
  }
}
