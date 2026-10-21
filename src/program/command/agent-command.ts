import { Option } from "commander";
import type { Command } from "commander";
import {
  loadLlmConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "../../core/llm";
import { runOneShotAgent, runReplAgent } from "../../core/conversation/agent";
import {
  APPROVAL_POLICIES,
  SANDBOX_LEVELS,
  type SandboxCliOptions,
} from "../../core/sandbox";
import type { ApprovalPolicy, SandboxLevel } from "../../core/sandbox/types";

/** agent 命令执行体的选项入参 */
interface AgentOptions {
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
 * @param {AgentOptions} opts - 命令行选项
 * @returns {SandboxCliOptions} 沙箱选项（未指定任何沙箱相关项时为空对象，走配置文件默认）
 */
function buildSandboxOptions(opts: AgentOptions): SandboxCliOptions {
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
 * agent 命令执行体：档位校验、配置装载与单次/多轮分流
 * 与 commander 解耦后可直接对分流与空参逻辑单测；
 * 空白任务（如 tx agent "" 或 tx agent "  "）按未传参处理，进入多轮任务模式而非向模型发送空任务；
 * Agent 模式为全量工具带（bash 受沙箱与审批管控），只读问答请用 chat 命令
 * @param {string[]} task - 命令位置参数（可变参数）
 * @param {AgentOptions} opts - 命令行选项
 * @returns {Promise<void>}
 */
export async function runAgentAction(
  task: string[],
  opts: AgentOptions,
): Promise<void> {
  // CLI 选项处理全部前置：loadLlmConfig 在配置缺失时会进入交互向导并写盘，
  // 必须先完成所有命令行选项的解析（枚举合法性已由 commander choices() 拦截）
  const thinkingLevel = parseThinkingLevel(opts.think);
  const sandboxCli = buildSandboxOptions(opts);
  const config = await loadLlmConfig();
  // commander 的 --no-mcp 取反约定：显式传入时 opts.mcp 为 false，缺省为 true
  const mcpEnabled = opts.mcp !== false;
  const taskText = task.join(" ").trim();
  if (taskText) {
    await runOneShotAgent(config, taskText, thinkingLevel, mcpEnabled, sandboxCli);
    return;
  }
  await runReplAgent(config, thinkingLevel, mcpEnabled, sandboxCli);
}

/**
 * 注册 agent 命令：让 AI Agent 执行任务（Agent 模式，对标 Codex CLI / Claude Code 默认模式）
 * 工具带为全量：只读内置工具 + bash（受三档沙箱与审批策略管控）+ 技能 + MCP；
 * 沙箱档位优先级：--sandbox > 环境变量 TX_SANDBOX_LEVEL > 配置文件 sandbox.level > read-only；
 * 审批策略优先级：--approval > 环境变量 TX_SANDBOX_APPROVAL > 配置文件 sandbox.approval > on-failure；
 * 枚举型选项经 choices() 声明：非法值由 commander 在 action 执行前拒绝，无需命令内手工校验
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerAgentCommand(program: Command): void {
  program
    .command("agent [task...]")
    .description(
      "让 AI Agent 执行任务（可读写文件、执行 bash，受沙箱与审批管控）：传入任务为单次执行，不带参数进入多轮任务模式",
    )
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
    .action(async (task: string[], opts: AgentOptions) => {
      await runAgentAction(task, opts);
    });
}
