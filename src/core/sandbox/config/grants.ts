import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 解析项目空间沙箱配置文件路径：<cwd>/.tx-cli/config.json
 * 与全局 ~/.tx-cli/config.json 同构；当前仅 sandbox.rules.allow（「始终允许」授权）在此生效
 * @param {string} cwd - 项目根目录（绝对路径）
 * @returns {string} 项目配置文件绝对路径
 */
export function resolveProjectConfigPath(cwd: string): string {
  return join(cwd, ".tx-cli", "config.json");
}

/**
 * 读取项目空间的「始终允许」授权（sandbox.rules.allow 字符串数组）
 * 文件不存在或损坏时返回空列表；仅读取该段，文件中的其余配置不在此生效
 * @param {string} cwd - 项目根目录（绝对路径）
 * @param {string} path - 项目配置文件路径（缺省 <cwd>/.tx-cli/config.json，测试可注入）
 * @returns {string[]} 授权规则列表
 */
export function readProjectGrants(
  cwd: string,
  path: string = resolveProjectConfigPath(cwd),
): string[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const sandbox = (parsed as Record<string, unknown>).sandbox;
    if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) {
      return [];
    }
    const rules = (sandbox as Record<string, unknown>).rules;
    if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
      return [];
    }
    const allow = (rules as Record<string, unknown>).allow;
    if (!Array.isArray(allow) || allow.some((a) => typeof a !== "string")) {
      return [];
    }
    return allow as string[];
  } catch {
    return [];
  }
}

/**
 * 追加一条「始终允许」授权到项目空间配置文件（不存在则创建，重复规则不重复写入）
 * 保留文件中其余字段，仅更新 sandbox.rules.allow；授权归属当前项目，不跨项目生效
 * @param {string} cwd - 项目根目录（绝对路径）
 * @param {string} rule - 规则文本（格式同 rules.allow，如 bash(git status:*)）
 * @param {string} path - 项目配置文件路径（缺省 <cwd>/.tx-cli/config.json，测试可注入）
 * @returns {void}
 */
export function appendProjectGrant(
  cwd: string,
  rule: string,
  path: string = resolveProjectConfigPath(cwd),
): void {
  // 读原始 JSON 并保留未知字段，只重写 sandbox.rules.allow 路径
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        // object 收窄后缺少 index signature，需显式断言为 Record
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // 损坏文件无法解析：从空结构重建（原内容本就不可读）
    }
  }
  const sandboxRecord: Record<string, unknown> =
    typeof raw.sandbox === "object" && raw.sandbox !== null && !Array.isArray(raw.sandbox)
      ? (raw.sandbox as Record<string, unknown>)
      : {};
  const rulesRecord: Record<string, unknown> =
    typeof sandboxRecord.rules === "object" &&
    sandboxRecord.rules !== null &&
    !Array.isArray(sandboxRecord.rules)
      ? (sandboxRecord.rules as Record<string, unknown>)
      : {};
  const allow =
    Array.isArray(rulesRecord.allow) && rulesRecord.allow.every((a) => typeof a === "string")
      ? [...(rulesRecord.allow as string[])]
      : [];
  if (allow.includes(rule)) {
    return;
  }
  allow.push(rule);
  raw.sandbox = { ...sandboxRecord, rules: { ...rulesRecord, allow } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
