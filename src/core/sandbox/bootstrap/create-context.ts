import type { SandboxProvider } from "../types";
import { loadSandboxConfig } from "../config/load";
import {
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "../../../shared/user-config";
import { mergeStringArrays } from "../../../shared/config-merge";
import { buildTierConfig } from "../runtime/tier-config";
import { getProvider } from "../providers/registry";
import { SandboxContext } from "../runtime/sandbox-context";
import {
  detectInteractive,
  interactiveApprover,
} from "../runtime/interactive-approver";
import { resolveOptions, type SandboxCliOptions } from "./options";
import { grantGlobalTrust, resolveUntrustedFallback } from "./trust";

/** createSandboxContext 的调用方上下文选项 */
export interface CreateSandboxContextOptions {
  /** 会话模式是否强制不装配 bash（如 chat 只读问答） */
  bashForcedOff?: boolean;
  /** 目录信任确认回调（缺省为交互式确认；非交互环境不会调用，测试可注入） */
  trustPrompt?: (cwd: string) => Promise<boolean>;
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
 *
 * 装配链路：enabled 开关 → 配置装载与两级合并（loadSandboxConfig）→ 选项合并（优先级链路见 bootstrap/options.ts）
 * → 信任确认与降级（语义见 bootstrap/trust.ts）→ Provider 选择与初始化 → 构建 SandboxContext；
 * bash 装配开关与沙箱上下文解耦：--no-bash 只移除 bash 工具，上下文仍承担只读工具的 fs 门卫；
 * bashForcedOff（chat 等强制无 bash 的模式）时跳过 Provider 装载并抑制 bash 相关警告；
 * --sandbox <level> 显式传入时同时启用沙箱（覆盖配置 sandbox.enabled=false）；
 * 沙箱被配置禁用且未传 --sandbox 时，--approval / --sandbox-missing 不生效并输出警告
 * @param {SandboxCliOptions} cliOptions - 命令行选项
 * @param {CreateSandboxContextOptions} contextOptions - 调用方上下文选项（字段说明见接口定义）
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
  // 信任确认与降级决策见 bootstrap/trust.ts（resolveUntrustedFallback）
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
    contextOptions.trustPrompt,
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
  // 都会被沙箱代理以 403 拒绝（allow-only 语义），提前告知配置入口而非让用户在报错里猜
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

  // 项目配置已由 loadSandboxConfig 合并装载：授权归属当前项目，不跨项目生效

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
