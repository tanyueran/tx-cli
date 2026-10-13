import { readTextFile } from "./fs";

/** 单行回显的最大字符数：超长行截断，避免单行占用过多上下文 */
const MAX_LINE_CHARS = 300;

/**
 * 将 glob 模式编译为正则：支持 **（跨目录）、*（单层内任意字符）、?（单层内单字符）
 * @param {string} pattern - glob 模式，使用 / 作为路径分隔符
 * @returns {RegExp} 用于匹配相对路径的正则（整体锚定）
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // **/ 匹配任意层目录（含零层）；单独的 ** 匹配任意字符
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** 单行命中结果 */
export interface TextMatch {
  /** 行号（从 1 开始） */
  line: number;
  /** 命中行内容（超长已截断，末尾以 … 标记） */
  text: string;
}

/**
 * 在单个文本文件中按正则查找命中行
 * 文件过大、为二进制文件或读取失败时返回空数组（视为无命中）
 * @param {string} absolutePath - 文件绝对路径
 * @param {RegExp} regex - 匹配正则（不应带 g 标志，避免 lastIndex 状态污染）
 * @param {number} limit - 最多返回的命中行数
 * @returns {Promise<TextMatch[]>} 命中行列表
 */
export async function findTextMatches(
  absolutePath: string,
  regex: RegExp,
  limit: number
): Promise<TextMatch[]> {
  let content: string;
  try {
    content = await readTextFile(absolutePath);
  } catch {
    // 过大/二进制/不可读：跳过该文件
    return [];
  }
  const matches: TextMatch[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= limit) {
      break;
    }
    const line = lines[i];
    if (!regex.test(line)) {
      continue;
    }
    matches.push({
      line: i + 1,
      text:
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
    });
  }
  return matches;
}
