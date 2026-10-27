import { resolve } from "node:path";
import type { SandboxLevel, TierConfig } from "../types";
import { matchPathPattern } from "../policy/path-match";

/** 应用层 fs 边界检查结果 */
export interface FsBoundaryResult {
  /** 是否允许本次读/写 */
  allowed: boolean;
  /** 拒绝时的中文原因 */
  reason?: string;
}

/**
 * 应用层 fs 读边界：读取前对照档位 TierConfig 校验
 * danger-full-access 档跳过检查；denyRead 命中即拒绝（deny-then-allow 语义）；
 * 路径先经 resolve 词法规范化（消解 .. 与 .），防止伪装路径绕过前缀/glob 匹配
 * @param {SandboxLevel} level - 沙箱档位
 * @param {TierConfig} tier - 档位边界配置
 * @param {string} path - 待读取的绝对路径
 * @returns {FsBoundaryResult} 拒绝时带中文原因
 */
export function checkFsRead(
  level: SandboxLevel,
  tier: TierConfig,
  path: string,
): FsBoundaryResult {
  if (level === "danger-full-access") {
    return { allowed: true };
  }
  const resolvedPath = resolve(path);
  for (const pattern of tier.denyRead) {
    if (matchPathPattern(pattern, resolvedPath)) {
      return {
        allowed: false,
        reason: `路径 ${resolvedPath} 命中当前档位禁读边界 ${pattern}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * 应用层 fs 写边界：写入前对照档位 TierConfig 校验（allow-only 语义）
 * danger-full-access 档跳过检查；路径必须落在 allowWrite 某个可写根内，
 * 且不命中 denyWrite 敏感模式（.env、*.pem 等）；
 * 路径先经 resolve 词法规范化（消解 .. 与 .），防止伪装路径绕过前缀匹配
 * @param {SandboxLevel} level - 沙箱档位
 * @param {TierConfig} tier - 档位边界配置
 * @param {string} path - 待写入的绝对路径
 * @returns {FsBoundaryResult} 拒绝时带中文原因
 */
export function checkFsWrite(
  level: SandboxLevel,
  tier: TierConfig,
  path: string,
): FsBoundaryResult {
  if (level === "danger-full-access") {
    return { allowed: true };
  }
  const resolvedPath = resolve(path);
  if (tier.allowWrite.length === 0) {
    return {
      allowed: false,
      reason: `当前档位为 ${level}，禁止一切文件写入`,
    };
  }
  const isWritable = tier.allowWrite.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(`${root}/`),
  );
  if (!isWritable) {
    return {
      allowed: false,
      reason: `路径 ${resolvedPath} 不在可写范围内（可写根：${tier.allowWrite.join("、")}）`,
    };
  }
  for (const pattern of tier.denyWrite) {
    if (matchPathPattern(pattern, resolvedPath)) {
      return {
        allowed: false,
        reason: `文件 ${resolvedPath} 命中禁写模式 ${pattern}`,
      };
    }
  }
  return { allowed: true };
}
