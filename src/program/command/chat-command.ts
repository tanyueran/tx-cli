import { Option } from "commander";
import type { Command } from "commander";
import {
  loadLlmConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "../../core/llm";
import { runOneShotChat, runReplChat } from "../../core/conversation/chat";
import {
  APPROVAL_POLICIES,
  SANDBOX_LEVELS,
  type SandboxCliOptions,
} from "../../core/sandbox";
import type { ApprovalPolicy, SandboxLevel } from "../../core/sandbox/types";

/** chat 命令执行体的选项入参 */
interface ChatOptions {
  /** 思考档位（--think），未指定时回退配置默认 */
  think?: string;
  /** 是否启用 MCP 服务器：--no-mcp 显式传入 false，缺省视为开启 */
  mcp?: boolean;
  /** 沙箱档位（--sandbox），未指定时回退 env 与配置默认 */
  sandbox?: string;
  /** 审批策略（--approval），未指定时回退 env 与配置默认 */
  approval?: string;
  /** 是否启用 bash 工具：--no-bash 显式传入 false，缺省视为开启 */
  bash?: boolean;
  /** 沙箱不可用时的处置（--sandbox-missing），缺省 deny（失败关闭） */
  sandboxMissing?: string;
}

/**
 * 组装沙箱 CLI 选项：枚举合法性已由 commander 的 choices() 在 action 执行前拦截，此处只做映射
 * @param {ChatOptions} opts - 命令行选项
 * @returns {SandboxCliOptions} 沙箱选项（未指定任何沙箱相关项时为空对象，走配置文件默认）
 */
function buildSandboxOptions(opts: ChatOptions): SandboxCliOptions {
  const sandbox: SandboxCliOptions = {};
  if (opts.sandbox !== undefined) {
    sandbox.level = opts.sandbox as SandboxLevel;
  }
  if (opts.approval !== undefined) {
    sandbox.approval = opts.approval as ApprovalPolicy;
  }
  // commander 的 --no-bash 取反约定：显式传入时 opts.bash 为 false，缺省为 true
  if (opts.bash === false) {
    sandbox.bashEnabled = false;
  }
  if (opts.sandboxMissing !== undefined) {
    sandbox.missingAction = opts.sandboxMissing as "allow" | "deny";
  }
  return sandbox;
}

/**
 * chat 命令执行体：档位校验、配置装载与单次/多轮分流
 * 与 commander 解耦后可直接对分流与空参逻辑单测；
 * 空白问题（如 tx chat "" 或 tx chat "  "）按未传参处理，进入多轮对话而非向模型发送空消息
 * @param {string[]} question - 命令位置参数（可变参数）
 * @param {ChatOptions} opts - 命令行选项
 * @returns {Promise<void>}
 */
export async function runChatAction(
  question: string[],
  opts: ChatOptions,
): Promise<void> {
  // CLI 选项处理全部前置：loadLlmConfig 在配置缺失时会进入交互向导并写盘，
  // 必须先完成所有命令行选项的解析（枚举合法性已由 commander choices() 拦截）
  const thinkingLevel = parseThinkingLevel(opts.think);
  const sandboxCli = buildSandboxOptions(opts);
  const config = await loadLlmConfig();
  // commander 的 --no-mcp 取反约定：显式传入时 opts.mcp 为 false，缺省为 true
  const mcpEnabled = opts.mcp !== false;
  const questionText = question.join(" ").trim();
  if (questionText) {
    await runOneShotChat(
      config,
      questionText,
      thinkingLevel,
      mcpEnabled,
      sandboxCli,
    );
    return;
  }
  await runReplChat(config, thinkingLevel, mcpEnabled, sandboxCli);
}

/**
 * 注册 chat 命令：与大模型对话
 * 思考档位优先级：--think > 环境变量 TX_LLM_THINKING_LEVEL > 配置文件 llm.thinkingLevel > medium
 * 枚举型选项经 choices() 声明：非法值由 commander 在 action 执行前拒绝，无需命令内手工校验
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerChatCommand(program: Command): void {
  program
    .command("chat [question...]")
    .description("与大模型对话：传入问题为单次问答，不带参数进入多轮对话模式")
    .addOption(
      new Option(
        "--think <level>",
        `思考档位：${THINKING_LEVELS.join(" | ")}，优先级：命令行 > 环境变量 TX_LLM_THINKING_LEVEL > 配置文件 llm.thinkingLevel（最终默认 medium）`,
      ).choices([...THINKING_LEVELS]),
    )
    .option(
      "--no-mcp",
      "禁用 MCP 服务器（默认读取 ~/.tx-cli/config.json 的 mcpServers 段）",
    )
    .addOption(
      new Option(
        "--sandbox <level>",
        `bash 命令的沙箱档位：${SANDBOX_LEVELS.join(" | ")}，优先级：命令行 > 环境变量 TX_SANDBOX_LEVEL > 配置文件 sandbox.level（最终默认 read-only）`,
      ).choices([...SANDBOX_LEVELS]),
    )
    .addOption(
      new Option(
        "--approval <policy>",
        `审批策略：${APPROVAL_POLICIES.join(" | ")}，优先级：命令行 > 环境变量 TX_SANDBOX_APPROVAL > 配置文件 sandbox.approval（最终默认 on-failure）`,
      ).choices([...APPROVAL_POLICIES]),
    )
    .option(
      "--no-bash",
      "禁用 bash 工具（默认读取 ~/.tx-cli/config.json 的 sandbox.bash.enabled）",
    )
    .addOption(
      new Option(
        "--sandbox-missing <action>",
        "沙箱在当前环境不可用时的处置：allow 降级为无隔离执行（规则与审批仍生效）| deny 失败关闭（默认）",
      ).choices(["allow", "deny"]),
    )
    .action(async (question: string[], opts: ChatOptions) => {
      await runChatAction(question, opts);
    });
}
