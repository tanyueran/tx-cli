import { basename, dirname, join } from "node:path";
import { constants, existsSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";

/**
 * 判断文件是否可执行：文件存在且具备执行权限
 * @param {string} path - 候选文件路径
 * @returns {Promise<boolean>} 可执行时为 true
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 严格区分大小写地判断文件是否存在
 * 说明：macOS/Windows 的文件系统对大小写不敏感，existsSync 无法区分 Foo.ts 与 foo.ts，
 * 因此需要再读取父目录列表做一次精确比对
 * @param {string} filepath - 待判断的文件路径
 * @returns {boolean} 文件存在且名称大小写完全一致时返回 true
 */
export function existsWithExactCase(filepath: string): boolean {
  if (!existsSync(filepath)) {
    return false;
  }

  const parentDir = dirname(filepath);
  const targetFile = basename(filepath);
  const files = readdirSync(parentDir);

  return files.includes(targetFile); // 严格匹配大小写
}

/** 读取文本文件的默认大小上限：1MB，超出直接拒绝，避免截断破坏内容或拖垮上下文 */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/**
 * 读取文本文件内容：带字节上限与二进制文件判断
 * @param {string} absolutePath - 文件绝对路径
 * @param {number} [maxBytes] - 允许的最大字节数，缺省 MAX_TEXT_FILE_BYTES
 * @returns {Promise<string>} 文件文本内容
 * @throws {Error} 文件过大、为二进制文件或读取失败时抛出，message 为可读原因
 */
export async function readTextFile(
  absolutePath: string,
  maxBytes: number = MAX_TEXT_FILE_BYTES
): Promise<string> {
  const info = await stat(absolutePath);
  if (info.size > maxBytes) {
    throw new Error(`文件过大（${info.size} 字节，上限 ${maxBytes} 字节）`);
  }
  const content = await readFile(absolutePath, "utf-8");
  // 含 NUL 字节视为二进制文件
  if (content.includes("\u0000")) {
    throw new Error("二进制文件不支持读取");
  }
  return content;
}

/** 默认忽略的目录名：避免扫描依赖与版本库等无关目录 */
export const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".git"]);

/** 单次遍历的默认条目上限：防止超大目录拖垮会话 */
const DEFAULT_MAX_ENTRIES = 5000;

/** 遍历到的条目 */
export interface WalkEntry {
  /** 相对遍历根目录的路径（统一使用 / 分隔符） */
  relativePath: string;
  /** 是否为目录 */
  isDirectory: boolean;
}

/** 目录遍历选项 */
export interface WalkOptions {
  /** 需要跳过的目录名（按目录名匹配），缺省为 DEFAULT_IGNORED_DIRS */
  ignoredDirs?: Set<string>;
  /** 最多返回的条目数，缺省 5000 */
  maxEntries?: number;
}

/**
 * 递归遍历目录：深度优先返回其下所有文件与子目录
 * 无权限或读取失败的目录会被跳过，不中断整体遍历
 * @param {string} root - 遍历的根目录绝对路径
 * @param {WalkOptions} [options] - 遍历选项
 * @returns {Promise<WalkEntry[]>} 条目列表；达到 maxEntries 上限时提前返回
 */
export async function walkDir(
  root: string,
  options: WalkOptions = {}
): Promise<WalkEntry[]> {
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries: WalkEntry[] = [];

  /**
   * 深度优先遍历单个目录
   * @param {string} dir - 当前目录的绝对路径
   * @param {string} prefix - 当前目录相对根目录的路径前缀
   * @returns {Promise<void>} 无返回值
   */
  async function visit(dir: string, prefix: string): Promise<void> {
    if (entries.length >= maxEntries) {
      return;
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不可读（无权限/已删除等）：跳过，不影响其他分支
      return;
    }
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        return;
      }
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (ignoredDirs.has(dirent.name)) {
          continue;
        }
        entries.push({ relativePath, isDirectory: true });
        await visit(join(dir, dirent.name), relativePath);
      } else if (dirent.isFile()) {
        entries.push({ relativePath, isDirectory: false });
      }
    }
  }

  await visit(root, "");
  return entries;
}
