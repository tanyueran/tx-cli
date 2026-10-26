import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 用户级配置文件读取结果：解析后的全文与读取过程中的警告 */
export interface UserConfigResult {
  /** 配置全文（顶层各段原样保留，llm/mcpServers 等由调用方各自取用） */
  data: Record<string, unknown>;
  /** 读取警告（文件损坏等），由调用方决定如何提示 */
  warnings: string[];
}

/** 配置缓存：路径 → 已解析的配置全文，保证同一进程内每个文件至多读一次磁盘 */
const cache = new Map<string, Record<string, unknown>>();

/**
 * 解析用户级配置文件路径：~/.tx-cli/config.json
 * @returns {string} 配置文件的绝对路径
 */
export function resolveUserConfigPath(): string {
  return join(homedir(), ".tx-cli", "config.json");
}

/**
 * 解析项目级配置文件路径：<cwd>/.tx-cli/config.json
 * 与全局配置同构（llm/sandbox/mcpServers 等段），标量字段项目覆盖全局，数组字段两层合并
 * @param {string} cwd - 项目根目录（绝对路径）
 * @returns {string} 项目配置文件绝对路径
 */
export function resolveProjectConfigPath(cwd: string): string {
  return join(cwd, ".tx-cli", "config.json");
}

/**
 * 读取用户级配置文件（带缓存）：首次读磁盘并缓存，后续直接返回缓存内容
 * 仅负责文件 IO 与 JSON 解析，不做任何输出；各段（llm、mcpServers 等）的校验由对应模块完成
 * 文件不存在时不缓存（存在性检查开销极小，保证进程运行期间新建的文件仍可被发现）；
 * 文件损坏时缓存空对象（进程内不再重复读、不再重复告警）
 * @param {string} configPath - 配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @returns {UserConfigResult} 配置全文与读取警告（命中缓存时警告恒为空）
 */
export function readUserConfig(
  configPath: string = resolveUserConfigPath(),
): UserConfigResult {
  const cached = cache.get(configPath);
  if (cached) {
    return { data: cached, warnings: [] };
  }
  if (!existsSync(configPath)) {
    return { data: {}, warnings: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    // 顶层不是对象（如数组、纯字符串）时各段均取不到，按空配置处理
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      cache.set(configPath, {});
      return { data: {}, warnings: [] };
    }
    const data = parsed as Record<string, unknown>;
    cache.set(configPath, data);
    return { data, warnings: [] };
  } catch (err) {
    cache.set(configPath, {});
    return {
      data: {},
      warnings: [
        `配置文件 ${configPath} 解析失败：${
          (err as Error).message
        }，已忽略文件内容`,
      ],
    };
  }
}

/**
 * 更新配置文件的指定段（写配置的统一入口）
 * 基于现有全文（缓存优先）合并后写回，只替换目标段，其余段原样保留，
 * 避免各处单独写文件时互相覆盖；写盘成功后同步刷新缓存
 * @param {string} section - 段名，如 llm、mcpServers
 * @param {unknown} value - 段的新内容（整体替换）
 * @param {string} configPath - 配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @returns {void}
 */
export function updateConfigSection(
  section: string,
  value: unknown,
  configPath: string = resolveUserConfigPath(),
): void {
  const { data } = readUserConfig(configPath);
  const merged = { ...data, [section]: value };
  mkdirSync(dirname(configPath), { recursive: true });
  // 0o600：文件可能含密钥（llm.apiKey 等），仅允许当前用户读写
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  cache.set(configPath, merged);
}
