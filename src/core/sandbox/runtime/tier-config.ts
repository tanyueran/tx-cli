import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SandboxLevel, TierConfig } from "../types";
import type { SandboxFileConfig } from "../config/schema";
import { expandHome } from "../../../shared/paths";

/** read-only 档默认禁读的敏感目录（凭据与密钥存放处） */
export const DEFAULT_DENY_READ: readonly string[] = [
  `${expandHome("~")}/.ssh`,
  `${expandHome("~")}/.aws`,
  `${expandHome("~")}/.gnupg`,
];

/** workspace-write 档在可写根内仍禁写的敏感文件模式 */
export const DEFAULT_DENY_WRITE: readonly string[] = [".env", "*.pem"];

/**
 * 收集系统共享临时目录的可写路径
 * 脚本习惯写 /tmp，而 os.tmpdir() 在 macOS 上指向 /var/folders/...，两者不重合；
 * 且 /tmp 在 macOS 是指向 /private/tmp 的软链接，真实路径需一并放行
 * @returns {string[]} 需要额外放行的临时目录（Windows 由 os.tmpdir() 覆盖，返回空）
 */
function sharedTempRoots(): string[] {
  if (process.platform === "win32") {
    return [];
  }
  const roots = ["/tmp"];
  try {
    const real = realpathSync("/tmp");
    if (real !== "/tmp") {
      roots.push(real);
    }
  } catch {
    // /tmp 不存在或不可解析（极少见）时忽略，不影响其他可写根
  }
  return roots;
}

/**
 * 按原顺序去重路径列表
 * @param {string[]} paths - 候选路径
 * @returns {string[]} 去重后的路径
 */
function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * 按档位生成 TierConfig：三档沙箱的标准隔离参数（档位语义见 types.ts）
 * danger-full-access 无隔离：调用方不装配真实沙箱，此档返回值仅作展示
 * @param {SandboxLevel} level - 沙箱档位
 * @param {SandboxFileConfig} sandboxConfig - 用户沙箱配置（扩展限制合并进档位默认）
 * @param {string} cwd - 当前工作目录（workspace-write 档的可写根）
 * @returns {TierConfig} 档位配置
 */
export function buildTierConfig(
  level: SandboxLevel,
  sandboxConfig: SandboxFileConfig,
  cwd: string,
): TierConfig {
  const denyRead = [
    ...DEFAULT_DENY_READ,
    ...sandboxConfig.filesystem.denyRead.map(expandHome),
  ];
  if (level === "read-only") {
    return {
      level,
      denyRead,
      allowWrite: [],
      denyWrite: [],
      allowedDomains: [],
      deniedDomains: [],
    };
  }
  return {
    level,
    denyRead,
    allowWrite: uniquePaths([
      cwd,
      tmpdir(),
      ...sharedTempRoots(),
      ...sandboxConfig.filesystem.writableRoots.map(expandHome),
    ]),
    denyWrite: [...DEFAULT_DENY_WRITE, ...sandboxConfig.filesystem.denyWrite.map(expandHome)],
    allowedDomains: [...sandboxConfig.network.allowedDomains],
    deniedDomains: [],
  };
}
