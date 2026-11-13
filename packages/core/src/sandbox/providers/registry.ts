import { srtProvider } from "./srt";
import { noopProvider } from "./noop";
import { createLandlockProvider, LANDLOCK_PROVIDER_NAME } from "./landlock";
import type { SandboxProvider } from "../types";

/**
 * Provider 注册表：编译期固定的已知实现
 * 配置 sandbox.provider 按名称查找；未注册名称由装配层按缺依赖处理
 *
 * 注册表存工厂而非实例：带会话级状态的 Provider（如 landlock 的档位配置）
 * 每次查找返回新实例，避免多会话共用一份可变状态互相串味
 */
const registry = new Map<string, () => SandboxProvider>([
  [srtProvider.name, () => srtProvider],
  [noopProvider.name, () => noopProvider],
  [LANDLOCK_PROVIDER_NAME, createLandlockProvider],
]);

/**
 * 按名称查找已注册的沙箱 Provider（每次返回新实例）
 * @param {string} name - Provider 名称（如 srt、noop）
 * @returns {SandboxProvider | undefined} 注册的 Provider，未知名称时为 undefined
 */
export function getProvider(name: string): SandboxProvider | undefined {
  const factory = registry.get(name);
  return factory ? factory() : undefined;
}

/**
 * 列出全部已注册的 Provider 名称
 * @returns {string[]} 名称列表
 */
export function listProviderNames(): string[] {
  return [...registry.keys()];
}
