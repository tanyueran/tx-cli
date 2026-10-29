import pico from "picocolors";
import { resolve } from "node:path";
import type {
  ApprovalPolicy,
  SandboxLevel,
  SandboxMissingAction,
  SandboxProvider,
} from "./types";
import { loadSandboxConfig } from "./config/load";
import {
  readGlobalConfig,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
  updateConfigSection,
} from "../../shared/user-config";
import { mergeStringArrays } from "../../shared/config-merge";
import { askConfirm } from "../../shared/interactive-prompt";
import { CancelError } from "../../shared/errors";
import type { SandboxFileConfig } from "./config/schema";
import { buildTierConfig } from "./policy/tier";
import { expandHome, isPathWithin } from "../../shared/paths";
import { getProvider } from "./providers/registry";
import { SandboxContext } from "./runtime/context";
import { detectInteractive, interactiveApprover } from "./runtime/approver";

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

/** L1 装配的中间结果：合并优先级后的生效参数 */
interface ResolvedOptions {
  /** 生效档位（CLI > 项目配置 > 全局配置） */
  level: SandboxLevel;
  /** 生效审批策略（CLI > 项目配置 > 全局配置） */
  approval: ApprovalPolicy;
  /** 档位是否来自配置文件（非信任目录的文件级 full/never 需降级） */
  levelFromFile: boolean;
  /** 审批策略是否来自配置文件 */
  approvalFromFile: boolean;
  /** 沙箱不可用时的处置 */
  missingAction: SandboxMissingAction;
}

/** createSandboxContext 的调用方上下文选项 */
export interface CreateSandboxContextOptions {
  /**
   * 会话模式是否强制不装配 bash（如 chat 只读问答）
   * 为 true 时：bash 装配开关直接置 false，跳过 Provider 选择与初始化（其仅服务于 bash 命令包装执行），
   * 并抑制仅与 bash 相关的警告（网络白名单 403 提示、Provider 不可用提示）；
   * 沙箱上下文仍创建，只读工具的 fs 门卫不受影响
   */
  bashForcedOff?: boolean;
  /**
   * 目录信任确认回调：当前目录不在 sandbox.trustDirectories 内且配置文件来源的
   * danger-full-access 档位 / never 审批策略需要信任时调用；
   * 缺省为交互式确认（TTY askConfirm，确认后写入全局配置）；
   * 非交互环境（无 TTY / CI / TX_SANDBOX_HEADLESS）不会调用，直接按降级处理；
   * 测试可注入假实现
   */
  trustPrompt?: (cwd: string) => Promise<boolean>;
}

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
  /** 档位是否来自配置文件 */
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
 * 经 user-config 缓存读取 + updateConfigSection 合并写回（0o600），信任缓存持久化后
 * 同目录后续启动不再重复询问
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
  const neverFromConfig = input.approvalFromFile && input.approval === "never";
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
 * 解析生效档位与审批策略：CLI > 项目配置 > 全局配置（两文件合并已由 loadSandboxConfig 完成）
 * @param {SandboxCliOptions} cliOptions - 命令行选项
 * @param {SandboxFileConfig} sandboxConfig - 配置文件（项目与全局合并后）
 * @returns {ResolvedOptions} 生效参数
 */
function resolveOptions(
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

/** L1 装配结果：沙箱上下文、bash 工具装配开关与装载警告的组合 */
export interface SandboxAssembly {
  /** 会话级沙箱上下文（sandbox.enabled 为 false 时不装配，为 undefined） */
  sandbox: SandboxContext | undefined;
  /** bash 工具是否装配：--no-bash 显式关闭，否则回退配置 sandbox.bash.enabled */
  bashEnabled: boolean;
  /** 装载警告（配置解析、信任目录降级、Provider 初始化等），由调用方统一展示 */
  warnings: string[];
}

/**
 * L1 装配：创建会话级沙箱上下文并解析 bash 装配开关
 * 装配链路：enabled 开关 → 优先级合并（CLI > 项目配置 > 全局配置，两文件合并由 loadSandboxConfig 完成，
 * 项目配置仅可收紧沙箱能力）→ 目录信任确认与降级（仅配置文件来源的 danger-full-access / never：
 * 交互确认信任后写入全局配置缓存，未确认则降级）→ Provider 选择与初始化 → 构建 SandboxContext；
 * bash 装配开关与沙箱上下文解耦：上下文承担只读工具的 fs 门卫，
 * --no-bash 只移除 bash 工具，不再连带关闭门卫；
 * bashForcedOff（chat 等强制无 bash 的模式）时跳过 Provider 装载并抑制 bash 相关警告；
 * --sandbox <level> 显式传入时同时启用沙箱（覆盖配置 sandbox.enabled=false），
 * 沙箱被配置禁用且未传 --sandbox 时，--approval / --sandbox-missing 不生效并输出警告
 * @param {SandboxCliOptions} cliOptions - 命令行选项
 * @param {CreateSandboxContextOptions} contextOptions - 调用方上下文选项（bashForcedOff / trustPrompt 说明见接口定义）
 * @returns {Promise<SandboxAssembly>} 沙箱上下文与 bash 装配开关
 */
export async function createSandboxContext(
  cliOptions: SandboxCliOptions = {},
  contextOptions: CreateSandboxContextOptions = {},
): Promise<SandboxAssembly> {
  const bashForcedOff = contextOptions.bashForcedOff === true;
  const warnings: string[] = [];
  const cwd = process.cwd();
  const { config: sandboxConfig, warnings: configWarnings } = loadSandboxConfig(
    {
      globalConfigPath: resolveGlobalConfigPath(),
      projectConfigPath: resolveProjectConfigPath(cwd),
    },
  );
  warnings.push(...configWarnings);
  const bashEnabled = bashForcedOff
    ? false
    : (cliOptions.bashEnabled ?? sandboxConfig.bash.enabled);
  // --sandbox <level> 显式传入视为要求本次启用沙箱：否则配置关闭沙箱时 CLI 档位会被静默忽略，
  // 与「命令行 > 配置文件」的优先级宣称矛盾（审批/missing 选项无法重新启用沙箱，只有档位可以）
  const cliForcesEnabled = cliOptions.level !== undefined;
  if (!sandboxConfig.enabled && !cliForcesEnabled) {
    if (
      cliOptions.approval !== undefined ||
      cliOptions.missingAction !== undefined
    ) {
      warnings.push(
        "沙箱已被配置禁用（sandbox.enabled=false），--approval / --sandbox-missing 不生效；如需本次启用可传 --sandbox <level>",
      );
    }
    return { sandbox: undefined, bashEnabled: false, warnings };
  }

  const resolvedOptions = resolveOptions(cliOptions, sandboxConfig);
  let { level, approval } = resolvedOptions;
  // 信任目录：配置文件来源的 full 档 / never 策略在非信任目录先征询信任
  //（交互确认后写入全局配置缓存，同目录后续启动不再询问），
  // 未确认信任（拒绝、取消、非交互）则降级，防止 clone 下来的仓库借自带配置自证信任
  const fallback = await resolveUntrustedFallback(
    {
      cwd,
      trustDirectories: sandboxConfig.trustDirectories,
      level,
      approval,
      levelFromFile: resolvedOptions.levelFromFile,
      approvalFromFile: resolvedOptions.approvalFromFile,
      interactive: detectInteractive(),
    },
    contextOptions.trustPrompt ?? defaultTrustPrompt,
  );
  if (fallback) {
    level = fallback.level;
    approval = fallback.approval;
    warnings.push(...fallback.warnings);
    if (fallback.granted) {
      grantGlobalTrust(cwd);
      sandboxConfig.trustDirectories = mergeStringArrays(
        sandboxConfig.trustDirectories,
        [cwd],
      );
    }
  }

  // 网络白名单提示：workspace-write 档空白名单意味着 bash 内所有联网命令（npm install、curl 等）
  // 都会被沙箱代理以 403 拒绝（allow-only 语义），提前告知配置入口而非让用户在报错里猜；
  // 仅在 bash 实际装配时提示（chat 等无 bash 会话该提示与其无关）
  if (
    bashEnabled &&
    level === "workspace-write" &&
    sandboxConfig.network.allowedDomains.length === 0
  ) {
    warnings.push(
      "sandbox.network.allowedDomains 为空：bash 命令的所有网络访问将被沙箱代理拒绝（HTTP 403），" +
        "如需 npm install / curl 等联网操作，请在 ~/.tx-cli/config.json 的 sandbox.network.allowedDomains 中放行域名",
    );
  }

  // Provider 仅服务于 bash 命令的包装执行；无 bash 会话（chat 等）跳过装载与相关警告
  let provider: SandboxProvider | undefined;
  if (!bashForcedOff) {
    // Provider 选择：full 档直通（noop）；其余档用配置的 Provider
    provider =
      level === "danger-full-access"
        ? getProvider("noop")
        : getProvider(sandboxConfig.provider);
    if (!provider && level !== "danger-full-access") {
      warnings.push(
        `未找到名为 ${sandboxConfig.provider} 的沙箱 Provider，bash 将以失败关闭模式运行`,
      );
    }
    // 初始化失败或环境不可用：按 missingAction 处置（默认 fail-closed）
    if (provider && level !== "danger-full-access") {
      let isProviderAvailable = false;
      try {
        isProviderAvailable = await provider.isAvailable();
        if (isProviderAvailable) {
          await provider.initialize(buildTierConfig(level, sandboxConfig, cwd));
        }
      } catch (err) {
        // isAvailable/initialize 抛错时 isProviderAvailable 保持 false，走不可用分支
        warnings.push(
          `沙箱 Provider ${provider.name} 初始化失败：${(err as Error).message}`,
        );
      }
      if (!isProviderAvailable) {
        if (resolvedOptions.missingAction === "allow") {
          warnings.push(
            `沙箱 Provider ${provider.name} 在当前环境不可用，已按 --sandbox-missing allow 降级为无隔离执行（规则与审批仍生效，read-only 档的写入隔离同样失效）`,
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
  }

  // 项目空间配置（<cwd>/.tx-cli/config.json）已由 loadSandboxConfig 与全局配置合并装载，
  // 授权归属当前项目，不跨项目生效；装载警告随返回值交由调用方统一展示

  return {
    sandbox: new SandboxContext({
      config: sandboxConfig,
      level,
      approval,
      provider,
      isInteractive: detectInteractive(),
      approver: interactiveApprover,
      cwd,
    }),
    bashEnabled,
    warnings,
  };
}
