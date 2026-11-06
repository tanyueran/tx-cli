import type {
  ApprovalPolicy,
  SandboxLevel,
  SandboxMissingAction,
} from "../types";
import type { SandboxFileConfig } from "../config/schema";

/** conversation 命令传入的沙箱 CLI 选项（均可选，未指定时走配置文件） */
export interface SandboxCliOptions {
  /** --no-bash 显式关闭 bash 工具；undefined 表示未指定 */
  bashEnabled?: boolean;
  /** --sandbox 指定的档位（显式传入时同时启用沙箱，覆盖配置 sandbox.enabled=false） */
  level?: SandboxLevel;
  /** --approval 指定的审批策略 */
  approval?: ApprovalPolicy;
  /** --sandbox-missing：沙箱不可用时的处置（allow 降级直通 / deny 失败关闭） */
  missingAction?: SandboxMissingAction;
}

/**
 * L1 装配的中间结果：合并优先级后的生效参数
 * 档位与审批策略的优先级链路：CLI > 项目配置 > 全局配置
 *（两文件的合并已由 loadSandboxConfig 完成，项目配置仅可收紧沙箱能力）
 */
export interface ResolvedOptions {
  /** 生效档位 */
  level: SandboxLevel;
  /** 生效审批策略 */
  approval: ApprovalPolicy;
  /** 档位是否来自配置文件（非信任目录的文件级 full/never 需降级） */
  levelFromFile: boolean;
  /** 审批策略是否来自配置文件 */
  approvalFromFile: boolean;
  /** 沙箱不可用时的处置 */
  missingAction: SandboxMissingAction;
}

/**
 * 合并 CLI 选项与配置文件为生效参数（优先级链路见 ResolvedOptions 注释）
 * @param {SandboxCliOptions} cliOptions - 命令行选项
 * @param {SandboxFileConfig} sandboxConfig - 配置文件（项目与全局合并后）
 * @returns {ResolvedOptions} 生效参数
 */
export function resolveOptions(
  cliOptions: SandboxCliOptions,
  sandboxConfig: SandboxFileConfig,
): ResolvedOptions {
  return {
    level: cliOptions.level ?? sandboxConfig.level,
    approval: cliOptions.approval ?? sandboxConfig.approval,
    levelFromFile: cliOptions.level === undefined,
    approvalFromFile: cliOptions.approval === undefined,
    missingAction: cliOptions.missingAction ?? "deny",
  };
}
