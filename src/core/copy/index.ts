import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { copy as fsCopy } from "fs-extra";
import { CliError } from "../../shared/errors";
import { globToRegExp } from "../../shared/text";

/** copy 命令的执行选项 */
export interface CopyOptions {
  /** 源路径（绝对路径或相对当前工作目录） */
  src: string;
  /** 目标路径（绝对路径或相对当前工作目录） */
  dest: string;
  /** 排除规则列表，glob 语法，基于源目录的相对路径匹配，命中即跳过 */
  filters?: string[];
}

/** copy 命令的执行结果 */
export interface CopyResult {
  /** 实际写入的目标路径（已按目标类型语义解析） */
  targetPath: string;
  /** 实际复制的文件数（不含目录） */
  copiedFiles: number;
  /** 被排除规则跳过的条目数（含目录） */
  skippedEntries: number;
}

/**
 * 把路径分隔符统一为正斜杠，保证 glob 匹配口径一致
 * @param {string} value - 待转换的路径
 * @returns {string} 使用 / 分隔的路径
 */
function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * 读取路径的 stat 信息，路径不存在时返回 null
 * @param {string} target - 待读取的路径
 * @returns {Promise<Stats | null>} stat 信息；不存在时为 null
 */
async function statSafe(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * 判断 child 是否位于 parent 目录内部（不含两者相同的情况）
 * @param {string} parent - 父目录路径
 * @param {string} child - 待判断的路径
 * @returns {boolean} child 位于 parent 内部时返回 true
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 按目标类型语义解析实际写入路径
 * 规则：目标不存在时直接作为目标；目标已存在且是目录时复制进该目录（目标/源名）；
 * 源是目录而目标已存在且是文件时视为非法
 * @param {string} src - 源路径（绝对路径）
 * @param {string} dest - 目标路径（绝对路径）
 * @returns {Promise<string>} 实际写入的目标路径
 * @throws {CliError} 源不存在或目录覆盖文件时抛出
 */
export async function resolveCopyTarget(
  src: string,
  dest: string
): Promise<string> {
  const srcStat = await statSafe(src);
  if (!srcStat) {
    throw new CliError(`源路径不存在：${src}`);
  }

  const destStat = await statSafe(dest);
  if (!destStat) {
    return dest;
  }
  if (destStat.isDirectory()) {
    return join(dest, basename(src));
  }
  if (srcStat.isDirectory()) {
    throw new CliError(`无法用目录覆盖已存在的文件：${dest}`);
  }
  return dest;
}

/**
 * 复制文件或目录，支持按 glob 规则排除部分文件
 * 复制走 fs-extra 的字节流，二进制文件与权限位均按原样保留
 * @param {CopyOptions} options - 复制选项
 * @returns {Promise<CopyResult>} 复制的目标路径与统计信息
 * @throws {CliError} 源不存在、目标位于源内部或复制失败时抛出
 */
export async function copyPath(options: CopyOptions): Promise<CopyResult> {
  const src = resolve(options.src);
  const dest = resolve(options.dest);

  const srcStat = await statSafe(src);
  if (!srcStat) {
    throw new CliError(`源路径不存在：${src}`);
  }
  const srcIsFile = srcStat.isFile();

  const targetPath = await resolveCopyTarget(src, dest);

  if (src === targetPath) {
    throw new CliError(`源路径与目标路径相同：${src}`);
  }
  if (isInside(src, targetPath)) {
    throw new CliError(`目标路径不能位于源路径内部：${targetPath}`);
  }

  // 形如 "node_modules/**" 的规则同时用于匹配目录自身，避免只过滤内容而留下空目录
  const matchers = (options.filters ?? [])
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .flatMap((item) =>
      item.endsWith("/**") && item.length > 3 ? [item, item.slice(0, -3)] : [item]
    )
    .map(globToRegExp);

  const stats = { copiedFiles: 0, skippedEntries: 0 };

  /**
   * fs-extra 的过滤回调：命中排除规则返回 false 以跳过该条目
   * @param {string} currentSrc - 当前待复制的源路径（绝对路径）
   * @returns {Promise<boolean>} 保留返回 true，排除返回 false
   */
  async function filter(currentSrc: string): Promise<boolean> {
    const rel = toPosix(relative(src, currentSrc));
    // 单文件源以文件名参与匹配，其余以相对路径匹配；目录源的根条目不参与匹配
    const matchKey = rel || (srcIsFile ? basename(src) : "");
    if (matchKey && matchers.some((regex) => regex.test(matchKey))) {
      stats.skippedEntries += 1;
      return false;
    }
    if (!rel) {
      // 根条目：源本身是单个文件时计入统计
      if (srcIsFile) {
        stats.copiedFiles += 1;
      }
      return true;
    }
    if ((await lstat(currentSrc)).isFile()) {
      stats.copiedFiles += 1;
    }
    return true;
  }

  try {
    await fsCopy(src, targetPath, { filter, overwrite: true });
  } catch (err) {
    throw new CliError(`复制失败：${(err as Error).message}`);
  }

  return {
    targetPath,
    copiedFiles: stats.copiedFiles,
    skippedEntries: stats.skippedEntries,
  };
}
