import { resolve } from "node:path";
import type {
  ApprovalPolicy,
  SandboxLevel,
  SandboxMissingAction,
} from "./types";
import { loadSandboxConfig } from "./config/load";
import {
  resolveProjectConfigPath,
  resolveUserConfigPath,
} from "../../shared/user-config";
import type { SandboxFileConfig } from "./config/schema";
import { buildTierConfig } from "./policy/tier";
import { expandHome } from "./policy/path-match";
import { getProvider } from "./providers/registry";
import { SandboxContext } from "./runtime/context";
import { detectInteractive, interactiveApprover } from "./runtime/approver";

/** conversation 命令传入的沙箱 CLI 选项（均可选，未指定时走配置文件） */
export interface SandboxCliOptions {
  /** --no-bash 显式关闭 bash 工具；undefined 表示未指定 */
  bashEnabled?: boolean;
  /** --sandbox 指定的档位 */
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
  return trustDirectories.some((dir) => {
    const expandedDir = resolve(expandHome(dir));
    return cwd === expandedDir || cwd.startsWith(`${expandedDir}/`);
  });
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
 * 装配链路：enabled 开关 → 优先级合并（CLI > 项目配置 > 全局配置，两文件合并由 loadSandboxConfig 完成）→
 * 信任目录降级（仅配置文件来源的 danger-full-access / never）→ Provider 选择与初始化 →
 * 构建 SandboxContext；
 * bash 装配开关与沙箱上下文解耦：上下文承担只读工具的 fs 门卫，
 * --no-bash 只移除 bash 工具，不再连带关闭门卫
 * @param {SandboxCliOptions} cliOptions - 命令行选项
 * @returns {Promise<SandboxAssembly>} 沙箱上下文与 bash 装配开关
 */
export async function createSandboxContext(
  cliOptions: SandboxCliOptions = {},
): Promise<SandboxAssembly> {
  const warnings: string[] = [];
  const cwd = process.cwd();
  const { config: sandboxConfig, warnings: configWarnings } = loadSandboxConfig(
    resolveUserConfigPath(),
    resolveProjectConfigPath(cwd),
  );
  warnings.push(...configWarnings);
  const bashEnabled = cliOptions.bashEnabled ?? sandboxConfig.bash.enabled;
  if (!sandboxConfig.enabled) {
    return { sandbox: undefined, bashEnabled: false, warnings };
  }

  const resolvedOptions = resolveOptions(cliOptions, sandboxConfig);
  let { level, approval } = resolvedOptions;
  // 信任目录：配置文件来源的 full 档 / never 策略在非信任目录降级，防止误配置放大权限
  if (!isTrusted(cwd, sandboxConfig.trustDirectories)) {
    if (resolvedOptions.levelFromFile && level === "danger-full-access") {
      level = "workspace-write";
      warnings.push(
        "当前目录不在 sandbox.trustDirectories 内，danger-full-access 已降级为 workspace-write",
      );
    }
    if (resolvedOptions.approvalFromFile && approval === "never") {
      approval = "on-failure";
      warnings.push(
        "当前目录不在 sandbox.trustDirectories 内，approval: never 已降级为 on-failure",
      );
    }
  }

  // 网络白名单提示：workspace-write 档空白名单意味着 bash 内所有联网命令（npm install、curl 等）
  // 都会被沙箱代理以 403 拒绝（allow-only 语义），提前告知配置入口而非让用户在报错里猜
  if (level === "workspace-write" && sandboxConfig.network.allowedDomains.length === 0) {
    warnings.push(
      "sandbox.network.allowedDomains 为空：bash 命令的所有网络访问将被沙箱代理拒绝（HTTP 403），" +
        "如需 npm install / curl 等联网操作，请在 ~/.tx-cli/config.json 的 sandbox.network.allowedDomains 中放行域名",
    );
  }

  // Provider 选择：full 档直通（noop）；其余档用配置的 Provider
  let provider =
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
