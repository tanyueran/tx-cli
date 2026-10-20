import { spawn } from "node:child_process";
import type { SandboxContext } from "../../sandbox/gate";
import type { Tool, ToolOutput } from "../types";

/** bash 参数中 timeout 的下限（毫秒） */
const MIN_TIMEOUT_MS = 1_000;
/** bash 参数中 timeout 的上限（毫秒，10 分钟） */
const MAX_TIMEOUT_MS = 600_000;
/**
 * 执行器层超时：取模型可请求的最大值加余量，
 * 实际超时由工具内部 spawn 控制（超时后自行 kill 并返回说明）
 */
const EXECUTOR_TIMEOUT_MS = MAX_TIMEOUT_MS + 5_000;

/** 单次 spawn 的执行结果 */
interface SpawnResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码（被信号杀死时为 -1） */
  exitCode: number;
  /** 是否因内部超时被 kill */
  timedOut: boolean;
}

/**
 * 在 shell 中执行命令并收集输出（带超时强杀）
 * @param {string} command - 待执行的命令文本（含 shell 包装时为包装后的形态）
 * @param {number} timeoutMs - 超时毫秒数，超时后 SIGKILL
 * @returns {Promise<SpawnResult>} 执行结果
 */
function spawnShell(
  command: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      stderr += `${err.message}\n`;
      finish(-1);
    });
    child.on("close", (code) => {
      finish(code ?? -1);
    });
  });
}

/**
 * 拼接命令执行输出（成功回传模型）
 * @param {SpawnResult} result - 执行结果
 * @returns {string} 输出文本
 */
function formatOutput(result: SpawnResult): string {
  const parts: string[] = [];
  if (result.stdout.trim()) {
    parts.push(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    parts.push(`[stderr]\n${result.stderr.trim()}`);
  }
  if (parts.length === 0) {
    return "（命令无输出）";
  }
  return parts.join("\n");
}

/**
 * 创建 bash 工具：受沙箱与权限门卫管控的命令执行
 * 由会话装配层按 L1 决策拼入工具列表（builtinTools 静态清单不含 bash），
 * 权限门卫（L2 规则 + L3 审批）由 permission 包装层负责，本工具 execute 只覆盖 L4：
 * 沙箱包装执行 → 违规标注回传 → on-failure 升级重跑
 * @param {SandboxContext} sandbox - 会话级沙箱上下文
 * @returns {Tool} bash 工具实例
 */
export function createBashTool(sandbox: SandboxContext): Tool {
  return {
    name: "bash",
    description:
      "执行 bash 命令并返回输出。受沙箱管控：非只读操作可能被拦截，被拦截时会返回违规说明，可据此调整命令或说明需要用户授权",
    timeoutMs: EXECUTOR_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令，复杂命令请用 && 或 ; 串联",
        },
        timeout: {
          type: "number",
          description: `超时毫秒数（${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}，缺省 ${sandbox.bashTimeoutMs}）`,
        },
      },
      required: ["command"],
    },
    permission: {
      capabilities: ["exec"],
      /**
       * 生成规则键
       * @param {Record<string, unknown>} args - 模型给出的参数
       * @returns {string} 形如 bash(git status) 的规则键
       */
      ruleKey(args: Record<string, unknown>): string {
        const command =
          typeof args.command === "string" ? args.command.trim() : "";
        return `bash(${command})`;
      },
      serial: true,
    },
    /**
     * 执行命令：L4 沙箱执行与失败升级
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 执行输出
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const command =
        typeof args.command === "string" ? args.command.trim() : "";
      if (!command) {
        return { ok: false, output: "缺少必填参数 command（命令文本）" };
      }
      // 模型可请求的超时钳制在 [1s, 10min]
      const requested =
        typeof args.timeout === "number" && Number.isFinite(args.timeout)
          ? args.timeout
          : sandbox.bashTimeoutMs;
      const timeoutMs = Math.min(
        Math.max(Math.floor(requested), MIN_TIMEOUT_MS),
        MAX_TIMEOUT_MS,
      );
      // danger-full-access 档：无沙箱直通执行
      if (sandbox.level === "danger-full-access") {
        const result = await spawnShell(command, timeoutMs);
        sandbox.recordAudit({
          tool: "bash",
          ruleKey: `bash(${command})`,
          decision: "allow",
          exitCode: result.exitCode,
        });
        if (result.timedOut) {
          return {
            ok: false,
            output: `命令执行超时（${timeoutMs}ms），已被终止\n${formatOutput(result)}`,
          };
        }
        return {
          ok: result.exitCode === 0,
          output:
            result.exitCode === 0
              ? formatOutput(result)
              : `${formatOutput(result)}\n退出码：${result.exitCode}`,
        };
      }
      // 其余档位需要沙箱 Provider；缺失即失败关闭
      if (!sandbox.provider) {
        return {
          ok: false,
          output:
            "当前环境的沙箱不可用，命令被拒绝执行（启动 CLI 时可用 --sandbox-missing allow 显式放行为无隔离执行）",
        };
      }
      const commandId = sandbox.newCommandId();
      const wrapped = await sandbox.provider.wrapCommand(command, {
        commandId,
        commandText: command,
      });
      const result = await spawnShell(wrapped, timeoutMs);
      const violation = await sandbox.provider.annotateStderr(
        commandId,
        result.stderr,
      );
      const baseOutput = `${formatOutput({ ...result, stderr: violation.annotated })}${
        result.exitCode === 0 ? "" : `\n退出码：${result.exitCode}`
      }`;
      sandbox.recordAudit({
        tool: "bash",
        ruleKey: `bash(${command})`,
        decision: "allow",
        exitCode: result.exitCode,
        violations: violation.events,
      });
      if (result.exitCode === 0) {
        return { ok: true, output: formatOutput(result) };
      }
      if (result.timedOut) {
        return {
          ok: false,
          output: `命令执行超时（${timeoutMs}ms），已被终止\n${baseOutput}`,
        };
      }
      // 沙箱违规导致的失败：回传违规说明供模型自纠；
      // on-failure 策略且可交互时提供升级通道（用户批准后脱离沙箱重跑一次）
      if (violation.events.length > 0) {
        const escalateNote =
          sandbox.approval === "on-failure" && sandbox.isInteractive
            ? await maybeEscalate(sandbox, command, timeoutMs)
            : null;
        if (escalateNote) {
          return escalateNote;
        }
        return {
          ok: false,
          output: `${baseOutput}\n命令被沙箱拦截：${violation.events.join("；")}\n可调整命令（如改为只读操作）或在配置中扩展沙箱边界`,
        };
      }
      return { ok: false, output: baseOutput };
    },
  };
}

/**
 * on-failure 升级问询：征得用户批准后脱离沙箱重跑原命令
 * @param {SandboxContext} sandbox - 会话级沙箱上下文
 * @param {string} command - 原始命令
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<ToolOutput | null>} 升级执行结果；用户拒绝或未批准时为 null
 */
async function maybeEscalate(
  sandbox: SandboxContext,
  command: string,
  timeoutMs: number,
): Promise<ToolOutput | null> {
  const approved = await sandbox.askEscalation(
    command,
    "命令被沙箱拦截导致失败",
  );
  if (!approved) {
    return null;
  }
  const rerun = await spawnShell(command, timeoutMs);
  sandbox.recordAudit({
    tool: "bash",
    ruleKey: `bash(${command})`,
    decision: "escalated",
    escalated: true,
    exitCode: rerun.exitCode,
  });
  const output = `${formatOutput(rerun)}${
    rerun.exitCode === 0 ? "" : `\n退出码：${rerun.exitCode}`
  }`;
  return {
    ok: rerun.exitCode === 0,
    output: `（经用户批准脱离沙箱重跑）\n${output}`,
  };
}
