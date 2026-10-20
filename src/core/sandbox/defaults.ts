import { homedir, tmpdir } from "node:os";
import type { SandboxLevel, TierConfig } from "./types";
import type { SandboxFileConfig } from "./config";

/** read-only 档默认禁读的敏感目录（凭据与密钥存放处） */
export const DEFAULT_DENY_READ: readonly string[] = [
  `${homedir()}/.ssh`,
  `${homedir()}/.aws`,
  `${homedir()}/.gnupg`,
];

/** workspace-write 档在可写根内仍禁写的敏感文件模式 */
export const DEFAULT_DENY_WRITE: readonly string[] = [".env", "*.pem"];

/**
 * 展开路径中的 ~ 前缀为家目录绝对路径
 * @param {string} path - 原始路径（以 ~ 或 ~/ 开头时展开）
 * @returns {string} 展开后的路径
 */
export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path;
}

/**
 * 把含通配符的路径模式编译为正则：** 跨目录匹配任意字符，* 仅匹配单段内字符（不含 /）
 * 通配符先作分隔符拿掉再转义剩余字面量，避免转义后的反斜杠干扰通配符语义
 * @param {string} pattern - 含 * 或 ** 的路径模式
 * @returns {RegExp} 锚定首尾的正则
 */
function compilePathGlob(pattern: string): RegExp {
  const regex = pattern
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${regex}$`);
}

/**
 * 判断路径是否命中路径模式（fs 边界检查的匹配口径）
 * 模式不含 / 时视为文件名模式，按任意目录下的同名（glob）匹配，使 .env、*.pem 命中任意层级；
 * 含 / 且含 * 时按完整路径 glob 匹配（** 跨目录、* 单段内）；
 * 含 / 且不含 * 时按路径前缀匹配（模式是目录时其子树全部命中，模式是文件时精确匹配）
 * @param {string} pattern - 路径模式（已展开 ~）
 * @param {string} path - 待检查的绝对路径
 * @returns {boolean} 命中时为 true
 */
export function matchPathPattern(pattern: string, path: string): boolean {
  if (pattern.includes("*") || !pattern.includes("/")) {
    const variants = pattern.includes("/") ? [pattern] : [`**/${pattern}`];
    return variants.some((candidate) => compilePathGlob(candidate).test(path));
  }
  const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
  return path === pattern || path.startsWith(prefix);
}

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
