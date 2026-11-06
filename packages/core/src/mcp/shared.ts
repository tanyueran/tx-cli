/**
 * stdio / http 两种传输类型共用的配置解析工具
 * 传输类型各自的差异逻辑放在 stdio.ts 与 http.ts，此处只保留通用能力
 */

/** ${VAR} 形式的环境变量引用 */
const ENV_VAR_RE = /\$\{([^}]+)\}/g;

/**
 * 展开字符串中的 ${VAR} 环境变量引用
 * 未定义的变量展开为空串（与常见 shell 行为一致），不报错
 * @param {string} rawValue - 待展开的字符串
 * @returns {string} 展开后的字符串
 */
export function expandVars(rawValue: string): string {
  return rawValue.replace(ENV_VAR_RE, (_, name) => process.env[name] ?? "");
}

/**
 * 展开记录中所有字符串值的 ${VAR} 引用
 * @param {Record<string, string>} record - 待展开的键值对
 * @returns {Record<string, string>} 展开后的新记录
 */
export function expandRecord(
  record: Record<string, string>,
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    expanded[key] = expandVars(value);
  }
  return expanded;
}

/**
 * 判断值是否为「字符串键 → 字符串值」的普通对象
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是字符串记录时为 true
 */
export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (fieldValue) => typeof fieldValue === "string",
  );
}

/**
 * 解析传输类型：显式 stdio/http 优先；缺省时按 command/url 字段推断（兼容 Claude Desktop 配置格式）
 * @param {Record<string, unknown>} record - 服务器配置的原始字段
 * @returns {"stdio" | "http" | undefined} 可识别的传输类型，无法识别时为 undefined
 */
export function inferType(
  record: Record<string, unknown>,
): "stdio" | "http" | undefined {
  if (record.type === "stdio" || record.type === "http") {
    return record.type;
  }
  if (record.type === undefined) {
    if (typeof record.command === "string") {
      return "stdio";
    }
    if (typeof record.url === "string") {
      return "http";
    }
  }
  return undefined;
}
