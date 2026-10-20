import { srtProvider } from "./providers/srt";
import { noopProvider } from "./providers/noop";
import { landlockProvider } from "./providers/landlock";
import type { SandboxProvider } from "./types";

/**
 * Provider 注册表：编译期固定的已知实现
 * 配置 sandbox.provider 按名称查找；未注册名称由装配层按缺依赖处理
 */
const registry = new Map<string, SandboxProvider>([
  [srtProvider.name, srtProvider],
  [noopProvider.name, noopProvider],
  [landlockProvider.name, landlockProvider],
]);

/**
 * 按名称查找已注册的沙箱 Provider
 * @param {string} name - Provider 名称（如 srt、noop）
 * @returns {SandboxProvider | undefined} 注册的 Provider，未知名称时为 undefined
 */
export function getProvider(name: string): SandboxProvider | undefined {
  return registry.get(name);
}

/**
 * 列出全部已注册的 Provider 名称
 * @returns {string[]} 名称列表
 */
export function listProviderNames(): string[] {
  return [...registry.keys()];
}
