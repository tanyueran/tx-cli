import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveProjectConfigPath } from "../../../shared/user-config";

/**
 * 追加一条「始终允许」授权到项目空间配置文件（不存在则创建，重复规则不重复写入）
 * 保留文件中其余字段，仅更新 sandbox.rules.allow；授权归属当前项目，不跨项目生效；
 * 读取侧由 loadSandboxConfig 按「项目 > 全局、数组合并」统一装载
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
