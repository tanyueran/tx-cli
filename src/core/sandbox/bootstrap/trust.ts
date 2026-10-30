import pico from "picocolors";
import { resolve } from "node:path";
import type { ApprovalPolicy, SandboxLevel } from "../types";
import {
  readGlobalConfig,
  resolveGlobalConfigPath,
  updateConfigSection,
} from "../../../shared/user-config";
import { askConfirm } from "../../../shared/interactive-prompt";
import { CancelError } from "../../../shared/errors";
import { expandHome, isPathWithin } from "../../../shared/paths";

/** 未信任目录降级决策的输入（resolveUntrustedFallback 用） */
export interface UntrustedFallbackInput {
  /** 当前工作目录（绝对路径） */
  cwd: string;
  /** 信任目录列表（全局配置来源） */
  trustDirectories: string[];
  /** 生效档位（CLI 与配置合并后） */
  level: SandboxLevel;
  /** 生效审批策略（CLI 与配置合并后） */
  approval: ApprovalPolicy;
  /** 档位是否来自配置文件（非 CLI） */
  levelFromFile: boolean;
  /** 审批策略是否来自配置文件 */
  approvalFromFile: boolean;
  /** 当前环境是否可交互（交互时才可能弹信任确认） */
  interactive: boolean;
}

/** 未信任目录降级决策的结果 */
export interface UntrustedFallbackResult {
  /** 是否确认信任（true 时调用方需将 cwd 写入全局配置并更新内存信任列表） */
  granted: boolean;
  /** 决策后的档位（未确认信任时降级） */
  level: SandboxLevel;
  /** 决策后的审批策略（未确认信任时降级） */
  approval: ApprovalPolicy;
  /** 决策过程的警告（信任确认提示或降级说明） */
  warnings: string[];
}

/**
 * 默认的目录信任确认回调：交互式 askConfirm，说明后果后请用户确认
 * 用户取消（Esc / Ctrl+C 抛 CancelError）视为不信任，本次按降级执行不中断会话
 * @param {string} cwd - 当前工作目录（绝对路径）
 * @returns {Promise<boolean>} 用户确认信任时为 true
 */
async function defaultTrustPrompt(cwd: string): Promise<boolean> {
  try {
    console.log(
      pico.yellow(
        "\n当前目录不在 sandbox.trustDirectories 内，配置文件中的 danger-full-access 档位 / never 审批策略需要信任当前目录后才会生效",
      ),
    );
    return await askConfirm(
      `是否信任当前目录 ${cwd}？（确认后写入全局配置 ~/.tx-cli/config.json）`,
      false,
    );
  } catch (err) {
    if (err instanceof CancelError) {
      return false;
    }
    throw err;
  }
}

/**
 * 将当前目录写入全局配置的 sandbox.trustDirectories（去重，保留 sandbox 段其余字段）
 * 信任持久化后同目录后续启动不再重复询问
 * @param {string} cwd - 当前工作目录（绝对路径）
 * @param {string} configPath - 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @returns {void}
 */
export function grantGlobalTrust(
  cwd: string,
  configPath: string = resolveGlobalConfigPath(),
): void {
  const { configData } = readGlobalConfig(configPath);
  const sectionRaw = configData.sandbox;
  const section: Record<string, unknown> =
    typeof sectionRaw === "object" &&
    sectionRaw !== null &&
    !Array.isArray(sectionRaw)
      ? { ...(sectionRaw as Record<string, unknown>) }
      : {};
  const existing =
    Array.isArray(section.trustDirectories) &&
    (section.trustDirectories as unknown[]).every(
      (item) => typeof item === "string",
    )
      ? (section.trustDirectories as string[])
      : [];
  if (existing.includes(cwd)) {
    return;
  }
  section.trustDirectories = [...existing, cwd];
  updateConfigSection("sandbox", section, configPath);
}

/**
 * 未信任目录时的降级决策：仅当文件来源（非 CLI）的 danger-full-access 档位或 never 审批策略
 * 出现在非信任目录时触发——交互环境弹信任确认（确认后按原值生效，由调用方写盘缓存信任），
 * 未确认信任（拒绝、取消、非交互）则降级（full → workspace-write、never → on-failure）并说明原因，
 * 防止 clone 下来的仓库借自带配置自证信任；CLI 显式传入的危险值不触发（用户本人意图）。
 * 已在信任目录内、或无文件来源危险配置时返回 null（无需处理）
 * @param {UntrustedFallbackInput} input - 决策输入（当前目录、信任列表、生效值与来源）
 * @param {(cwd: string) => Promise<boolean>} prompt - 信任确认回调（仅 interactive 为 true 时调用）
 * @returns {Promise<UntrustedFallbackResult | null>} null 表示无需处理，否则为决策结果
 */
export async function resolveUntrustedFallback(
  input: UntrustedFallbackInput,
  prompt: (cwd: string) => Promise<boolean> = defaultTrustPrompt,
): Promise<UntrustedFallbackResult | null> {
  const fullFromConfig =
    input.levelFromFile && input.level === "danger-full-access";
  const neverFromConfig =
    input.approvalFromFile && input.approval === "never";
  if (!fullFromConfig && !neverFromConfig) {
    return null;
  }
  if (isTrusted(input.cwd, input.trustDirectories)) {
    return null;
  }
  const granted = input.interactive ? await prompt(input.cwd) : false;
  if (granted) {
    return {
      granted: true,
      level: input.level,
      approval: input.approval,
      warnings: [
        `已信任当前目录 ${input.cwd} 并写入全局 ~/.tx-cli/config.json（sandbox.trustDirectories），本次配置文件来源的沙箱档位与审批策略按原值生效`,
      ],
    };
  }
  const guidance =
    "（可在交互启动时确认信任当前目录，或在全局 ~/.tx-cli/config.json 的 sandbox.trustDirectories 中手动添加）";
  const downgrades = [
    fullFromConfig ? "danger-full-access 已降级为 workspace-write" : undefined,
    neverFromConfig ? "approval: never 已降级为 on-failure" : undefined,
  ].filter((text) => text !== undefined);
  return {
    granted: false,
    level: fullFromConfig ? "workspace-write" : input.level,
    approval: neverFromConfig ? "on-failure" : input.approval,
    warnings: [
      `当前目录 ${input.cwd} 不在 sandbox.trustDirectories 内且未确认信任：${downgrades.join("、")}${guidance}`,
    ],
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
  return trustDirectories.some((dir) =>
    isPathWithin(resolve(expandHome(dir)), cwd),
  );
}
