import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SandboxProvider,
  SandboxViolationInfo,
  TierConfig,
} from "../../types";

/** 外部 helper 的可执行文件名（PATH 或 ~/.tx-cli/bin 下探测） */
const HELPER_BIN = "landlock-exec";

/** 显式指定 helper 路径的环境变量（测试与自定义安装位） */
const HELPER_ENV = "TX_SANDBOX_LANDLOCK_HELPER";

/** 用户级安装目录：~/.tx-cli/bin */
const USER_BIN_DIR = join(homedir(), ".tx-cli", "bin");

/** helper 初始化后的档位配置（wrapCommand 映射参数用） */
let tier: TierConfig | undefined;

/**
 * 判断文件是否可执行（存在且有执行权限）
 * @param {string} path - 候选路径
 * @returns {Promise<boolean>} 可执行时为 true
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测外部 helper 的安装位置
 * 查找顺序：TX_SANDBOX_LANDLOCK_HELPER 显式指定（跳过平台检查，信任用户声明）
 * → 仅 Linux 平台：PATH 各目录与 ~/.tx-cli/bin 下的 landlock-exec
 * @returns {Promise<string | null>} helper 绝对路径；未找到时为 null
 */
async function resolveHelperPath(): Promise<string | null> {
  const explicit = process.env[HELPER_ENV];
  if (explicit) {
    return (await isExecutable(explicit)) ? explicit : null;
  }
  if (process.platform !== "linux") {
    return null;
  }
  const candidates = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    USER_BIN_DIR,
  ].map((dir) => join(dir, HELPER_BIN));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 引号包裹路径参数（shell 安全）：已含引号的路径用单引号包裹并转义内部单引号
 * @param {string} value - 原始路径
 * @returns {string} shell 安全的带引号形态
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Landlock 沙箱 Provider：基于外部 helper（landlock-exec）的 Linux 内核级隔离
 * 现实约束：Node 无法直接发起 Landlock syscall（seccomp + prctl 需在 exec 前由父进程设置），
 * 因此设计为外部 helper 方案——helper 需用户自行安装（放置于 PATH 或 ~/.tx-cli/bin，
 * 或经 TX_SANDBOX_LANDLOCK_HELPER 指定路径），CLI 按约定的命令行参数调用它；
 * Landlock 是 allow-list 语义，denyRead 这类「父目录已授权时排除子树」无法表达，
 * 细粒度路径排除由应用层（fs 工具边界检查）与规则层兜底；
 * Landlock 违规表现为 EACCES/EPERM（信息已在 stderr 原文中），无结构化违规事件通道
 */
export const landlockProvider: SandboxProvider = {
  name: "landlock",

  /**
   * 探测可用性：helper 存在且可执行
   * @returns {Promise<boolean>} 可用时为 true
   */
  async isAvailable(): Promise<boolean> {
    return (await resolveHelperPath()) !== null;
  },

  /**
   * 初始化：保存档位配置（Landlock 边界在每次 exec 时由 helper 参数建立，无会话级资源）
   * @param {TierConfig} config - 档位配置
   * @returns {Promise<void>}
   */
  async initialize(config: TierConfig): Promise<void> {
    tier = config;
  },

  /**
   * 包装命令：改写为 helper 调用形态
   * `landlock-exec --ro-paths <逗号分隔> --rw-paths <逗号分隔> -- <command>`；
   * read-only 档只读根为 cwd，workspace-write 档只读根为全盘（/）+ 可写根 allowWrite
   * @param {string} command - 原始命令文本
   * @param {object} opts - 调用选项（Landlock helper 不消费，签名对齐接口）
   * @returns {Promise<string>} 包装后的可执行命令
   */
  async wrapCommand(
    command: string,
    opts: { commandId: string; commandText: string },
  ): Promise<string> {
    void opts;
    const helper = (await resolveHelperPath()) ?? HELPER_BIN;
    if (tier?.level === "read-only") {
      // read-only：只放行 cwd 读取，不传 --rw-paths（denyRead 的细粒度排除由应用层兜底）
      return `${shellQuote(helper)} --ro-paths ${shellQuote(process.cwd())} -- ${command}`;
    }
    // workspace-write：全盘可读（denyRead 由应用层兜底），allowWrite 为可写根
    const allowWrite = tier?.allowWrite ?? [];
    return `${shellQuote(helper)} --ro-paths ${shellQuote("/")} --rw-paths ${shellQuote(allowWrite.join(","))} -- ${command}`;
  },

  /**
   * 标注 stderr：透传原文（Landlock 无结构化违规事件，EACCES/EPERM 信息已在 stderr 中）
   * @param {string} commandId - 执行关联 ID（对齐接口，helper 不消费）
   * @param {string} stderr - 原始 stderr 输出
   * @returns {Promise<SandboxViolationInfo>} 原样透传与空事件列表
   */
  async annotateStderr(
    commandId: string,
    stderr: string,
  ): Promise<SandboxViolationInfo> {
    void commandId;
    return { annotated: stderr, events: [] };
  },

  /**
   * 释放资源：helper 按次调用，无会话级资源需要释放
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {
    tier = undefined;
  },
};

/** 仅用于测试：重置模块级档位状态 */
export const __resetLandlockForTest = (): void => {
  tier = undefined;
};
