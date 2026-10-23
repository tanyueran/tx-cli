import { resolve } from "node:path";
import type { ApprovalPolicy, SandboxLevel } from "./types";
import { loadSandboxConfig } from "./config/load";
import { readProjectGrants, resolveProjectConfigPath } from "./config/grants";
import type { SandboxFileConfig } from "./config/schema";
import { buildTierConfig } from "./policy/tier";
import { expandHome } from "./policy/path-match";
import { getProvider } from "./providers/registry";
import { SandboxContext } from "./runtime/context";
import { detectInteractive, interactiveApprover } from "./runtime/approver";

/** conversation 命令传入的沙箱 CLI 选项（均可选，未指定时走 env/配置文件） */
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
    approvalFromFile: cli.approval === undefined && envApproval === undefined,
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

/** L1 装配结果：沙箱上下文与 bash 工具装配开关的组合 */
export interface SandboxAssembly {
  /** 会话级沙箱上下文（sandbox.enabled 为 false 时不装配，为 undefined） */
  sandbox: SandboxContext | undefined;
  /** bash 工具是否装配：--no-bash 显式关闭，否则回退配置 sandbox.bash.enabled */
  bashEnabled: boolean;
}

/**
 * L1 装配：创建会话级沙箱上下文并解析 bash 装配开关
 * 装配链路：enabled 开关 → 优先级合并（CLI > env > 文件）→
 * 信任目录降级（仅文件来源的 danger-full-access / never）→ Provider 选择与初始化 →
 * 构建 SandboxContext；
 * bash 装配开关与沙箱上下文解耦：上下文承担只读工具的 fs 门卫，
 * --no-bash 只移除 bash 工具，不再连带关闭门卫
 * @param {SandboxCliOptions} cli - 命令行选项
 * @returns {Promise<SandboxAssembly>} 沙箱上下文与 bash 装配开关
 */
export async function createSandboxContext(
  cli: SandboxCliOptions = {},
): Promise<SandboxAssembly> {
  const warnings: string[] = [];
  const { config } = loadSandboxConfig();
  const bashEnabled = cli.bashEnabled ?? config.bash.enabled;
  if (!config.enabled) {
    return { sandbox: undefined, bashEnabled: false };
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

  // 网络白名单提示：workspace-write 档空白名单意味着 bash 内所有联网命令（npm install、curl 等）
  // 都会被沙箱代理以 403 拒绝（allow-only 语义），提前告知配置入口而非让用户在报错里猜
  if (level === "workspace-write" && config.network.allowedDomains.length === 0) {
    warnings.push(
      "sandbox.network.allowedDomains 为空：bash 命令的所有网络访问将被沙箱代理拒绝（HTTP 403），" +
        "如需 npm install / curl 等联网操作，请在 ~/.tx-cli/config.json 的 sandbox.network.allowedDomains 中放行域名",
    );
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

  // 项目空间授权（<cwd>/.tx-cli/config.json 的 sandbox.rules.allow）：
  // 授权归属当前项目，不跨项目生效；加载时提示来源，保证用户知情
  const projectAllow = readProjectGrants(cwd);
  if (projectAllow.length > 0) {
    warnings.push(
      `已加载项目授权文件 ${resolveProjectConfigPath(cwd)} 中的 ${projectAllow.length} 条放行规则`,
    );
  }

  for (const warning of warnings) {
    console.warn(warning);
  }
  return {
    sandbox: new SandboxContext({
      config,
      level,
      approval,
      provider,
      isInteractive: detectInteractive(),
      approver: interactiveApprover,
      cwd,
      projectAllow,
    }),
    bashEnabled,
  };
}
