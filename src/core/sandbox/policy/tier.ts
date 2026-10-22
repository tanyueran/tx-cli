import { tmpdir } from "node:os";
import type { SandboxLevel, TierConfig } from "../types";
import type { SandboxFileConfig } from "../config/schema";
import { expandHome } from "./path-match";

/** read-only 档默认禁读的敏感目录（凭据与密钥存放处） */
export const DEFAULT_DENY_READ: readonly string[] = [
  `${expandHome("~")}/.ssh`,
  `${expandHome("~")}/.aws`,
  `${expandHome("~")}/.gnupg`,
];

/** workspace-write 档在可写根内仍禁写的敏感文件模式 */
export const DEFAULT_DENY_WRITE: readonly string[] = [".env", "*.pem"];

/**
 * 按档位生成 TierConfig：三档沙箱的标准隔离参数
 * read-only：全禁写、全禁网，读侧禁凭据目录；
 * workspace-write：可写 cwd 与临时目录，禁写敏感文件，网络按用户配置；
 * danger-full-access：无隔离（调用方不装配真实沙箱，此档返回值仅作展示）
 * @param {SandboxLevel} level - 沙箱档位
 * @param {SandboxFileConfig} config - 用户沙箱配置（扩展限制合并进档位默认）
 * @param {string} cwd - 当前工作目录（workspace-write 档的可写根）
 * @returns {TierConfig} 档位配置
 */
export function buildTierConfig(
  level: SandboxLevel,
  config: SandboxFileConfig,
  cwd: string,
): TierConfig {
  const denyRead = [
    ...DEFAULT_DENY_READ,
    ...config.filesystem.denyRead.map(expandHome),
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
    allowWrite: [cwd, tmpdir(), ...config.filesystem.writableRoots.map(expandHome)],
    denyWrite: [...DEFAULT_DENY_WRITE, ...config.filesystem.denyWrite.map(expandHome)],
    allowedDomains: [...config.network.allowedDomains],
    deniedDomains: [],
  };
}
