import { resolve } from "node:path";
import type { ApprovalPolicy, SandboxLevel } from "./types";
import {
  loadSandboxConfig,
  type SandboxFileConfig,
} from "./config";
import { buildTierConfig, expandHome } from "./defaults";
import { getProvider } from "./provider";
import { SandboxContext, detectInteractive, interactiveApprover } from "./gate";

/** chat 命令传入的沙箱 CLI 选项（均可选，未指定时走 env/配置文件） */
export interface SandboxCliOptions {
  /** --no-bash 显式关闭 bash 工具；undefined 表示未指定 */
  bashEnabled?: boolean;
  /** --sandbox 指定的档位 */
  level?: SandboxLevel;
  /** --approval 指定的审批策略 */
  approval?: ApprovalPolicy;
  /** --sandbox-missing：沙箱不可用时的处置（allow 降级直通 / deny 失败关闭） */
  missingAction?: "allow" | "deny";
}

/** L1 装配的中间结果：合并优先级后的生效参数 */
interface ResolvedOptions {
  /** 生效档位（CLI > env > 文件） */
  level: SandboxLevel;
  /** 生效审批策略（CLI > env > 文件） */
  approval: ApprovalPolicy;
  /** 档位是否来自文件（非信任目录的文件级 full/never 需降级） */
  levelFromFile: boolean;
  /** 审批策略是否来自文件 */
  approvalFromFile: boolean;
  /** 沙箱不可用时的处置 */
  missingAction: "allow" | "deny";
}

/**
 * 解析 env 覆盖值：非法值忽略并返回警告
 * @param {string | undefined} value - 环境变量原始值
 * @param {string} name - 变量名（警告文案用）
 * @param {readonly T[]} allowed - 合法值集合
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {T | undefined} 合法值或 undefined
 */
function parseEnvOverride<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
  warnings: string[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    warnings.push(
      `环境变量 ${name}=${value} 非法（合法值：${allowed.join(" | ")}），已忽略`,
    );
    return undefined;
  }
  return value as T;
}

/**
 * 解析生效档位与审批策略：CLI > env(TX_SANDBOX_*) > 配置文件
 * @param {SandboxCliOptions} cli - 命令行选项
 * @param {SandboxFileConfig} config - 文件配置
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {ResolvedOptions} 生效参数
 */
function resolveOptions(
  cli: SandboxCliOptions,
  config: SandboxFileConfig,
  warnings: string[],
): ResolvedOptions {
  const envLevel = parseEnvOverride(
    process.env.TX_SANDBOX_LEVEL,
    "TX_SANDBOX_LEVEL",
    ["read-only", "workspace-write", "danger-full-access"],
    warnings,
  );
  const envApproval = parseEnvOverride(
    process.env.TX_SANDBOX_APPROVAL,
    "TX_SANDBOX_APPROVAL",
    ["always-ask", "on-failure", "never"],
    warnings,
  );
  const level = cli.level ?? envLevel ?? config.level;
  const approval = cli.approval ?? envApproval ?? config.approval;
  return {
    level,
    approval,
    levelFromFile: cli.level === undefined && envLevel === undefined,
    approvalFromFile:
      cli.approval === undefined && envApproval === undefined,
    missingAction: cli.missingAction ?? "deny",
  };
}

/**
 * 判断目录是否落在任一信任目录之下（含自身）
 * @param {string} cwd - 当前工作目录（绝对路径）
 * @param {string[]} trustDirectories - 信任目录列表（支持 ~）
 * @returns {boolean} 受信任时为 true
 */
function isTrusted(cwd: string, trustDirectories: string[]): boolean {
  if (trustDirectories.length === 0) {
    return false;
  }
  return trustDirectories.some((dir) => {
    const expanded = resolve(expandHome(dir));
    return cwd === expanded || cwd.startsWith(`${expanded}/`);
  });
}

/**
 * L1 装配：创建会话级沙箱上下文
 * 装配链路：enabled/bashEnabled 开关 → 优先级合并（CLI > env > 文件）→
 * 信任目录降级（仅文件来源的 danger-full-access / never）→ Provider 选择与初始化 →
 * 构建 SandboxContext；返回 undefined 表示本会话不装配 bash 工具
 * @param {SandboxCliOptions} cli - 命令行选项
 * @returns {Promise<SandboxContext | undefined>} 沙箱上下文；不装配时为 undefined
 */
export async function createSandboxContext(
  cli: SandboxCliOptions = {},
): Promise<SandboxContext | undefined> {
  const warnings: string[] = [];
  const { config } = loadSandboxConfig();
  const enabled = cli.bashEnabled ?? config.bash.enabled;
  if (!config.enabled || !enabled) {
    return undefined;
  }

  const resolved = resolveOptions(cli, config, warnings);
  let { level, approval } = resolved;
  // 信任目录：文件来源的 full 档 / never 策略在非信任目录降级，防止误配置放大权限
  const cwd = process.cwd();
  if (!isTrusted(cwd, config.trustDirectories)) {
    if (resolved.levelFromFile && level === "danger-full-access") {
      level = "workspace-write";
      warnings.push(
        "当前目录不在 sandbox.trustDirectories 内，danger-full-access 已降级为 workspace-write",
      );
    }
    if (resolved.approvalFromFile && approval === "never") {
      approval = "on-failure";
      warnings.push(
        "当前目录不在 sandbox.trustDirectories 内，approval: never 已降级为 on-failure",
      );
    }
  }

  // Provider 选择：full 档直通（noop）；其余档用配置的 Provider
  let provider =
    level === "danger-full-access"
      ? getProvider("noop")
      : getProvider(config.provider);
  if (!provider && level !== "danger-full-access") {
    warnings.push(
      `未找到名为 ${config.provider} 的沙箱 Provider，bash 将以失败关闭模式运行`,
    );
  }
  // 初始化失败或环境不可用：按 missingAction 处置（默认 fail-closed）
  if (provider && level !== "danger-full-access") {
    let available = false;
    try {
      available = await provider.isAvailable();
      if (available) {
        await provider.initialize(buildTierConfig(level, config, cwd));
      }
    } catch (err) {
      // isAvailable/initialize 抛错时 available 保持 false，走不可用分支
      warnings.push(
        `沙箱 Provider ${provider.name} 初始化失败：${(err as Error).message}`,
      );
    }
    if (!available) {
      if (resolved.missingAction === "allow") {
        warnings.push(
          `沙箱 Provider ${provider.name} 在当前环境不可用，已按 --sandbox-missing allow 降级为无隔离执行（规则与审批仍生效）`,
        );
        provider = getProvider("noop");
      } else {
        warnings.push(
          `沙箱 Provider ${provider.name} 在当前环境不可用，bash 将以失败关闭模式运行（可用 --sandbox-missing allow 显式放行）`,
        );
        provider = undefined;
      }
    }
  }

  for (const warning of warnings) {
    console.warn(warning);
  }
  return new SandboxContext({
    config,
    level,
    approval,
    provider,
    isInteractive: detectInteractive(),
    approver: interactiveApprover,
  });
}
