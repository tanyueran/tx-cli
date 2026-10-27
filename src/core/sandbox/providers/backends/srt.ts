import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type {
  SandboxProvider,
  SandboxViolationInfo,
  TierConfig,
} from "../../types";

/**
 * srt Provider：@anthropic-ai/sandbox-runtime 的适配层
 * 本文件是整个代码库中唯一 import sandbox-runtime 的位置，
 * 未来替换沙箱实现（如自研 Landlock）只需提供新的 Provider 注册进注册表
 */
export const srtProvider: SandboxProvider = {
  name: "srt",

  /**
   * 探测当前环境是否可用：平台受支持且依赖齐全
   * @returns {Promise<boolean>} 可用时为 true
   */
  async isAvailable(): Promise<boolean> {
    if (!SandboxManager.isSupportedPlatform()) {
      return false;
    }
    const dependencyCheck = await SandboxManager.checkDependenciesAsync();
    return dependencyCheck.errors.length === 0;
  },

  /**
   * 初始化 srt 会话：把 TierConfig 翻译为 SandboxRuntimeConfig
   * 写入为 allow-only、读取为 deny 列表，路径预先展开 ~
   * @param {TierConfig} tierConfig - 档位配置
   * @returns {Promise<void>}
   */
  async initialize(tierConfig: TierConfig): Promise<void> {
    const runtimeConfig: SandboxRuntimeConfig = {
      network: {
        allowedDomains: tierConfig.allowedDomains,
        deniedDomains: tierConfig.deniedDomains,
      },
      filesystem: {
        denyRead: tierConfig.denyRead,
        allowWrite: tierConfig.allowWrite,
        denyWrite: tierConfig.denyWrite,
      },
    };
    await SandboxManager.initialize(runtimeConfig);
  },

  /**
   * 包装命令：交由 SandboxManager 注入沙箱执行包装
   * @param {string} command - 原始命令文本
   * @param {{ commandId: string; commandText: string }} wrapOptions - 调用选项
   * @param {string} wrapOptions.commandId - 执行关联 ID（违规归因）
   * @param {string} wrapOptions.commandText - 用户可见命令文本
   * @returns {Promise<string>} 包装后的命令
   */
  async wrapCommand(
    command: string,
    wrapOptions: { commandId: string; commandText: string },
  ): Promise<string> {
    return SandboxManager.wrapWithSandbox(
      command,
      undefined,
      undefined,
      undefined,
      { commandId: wrapOptions.commandId, commandText: wrapOptions.commandText },
    );
  },

  /**
   * 标注 stderr：附加沙箱违规说明，并返回违规事件供审计
   * @param {string} commandId - 执行关联 ID
   * @param {string} stderr - 原始 stderr
   * @returns {Promise<SandboxViolationInfo>} 标注结果与违规事件
   */
  async annotateStderr(
    commandId: string,
    stderr: string,
  ): Promise<SandboxViolationInfo> {
    const annotatedStderr = SandboxManager.annotateStderrWithSandboxFailures(
      commandId,
      stderr,
    );
    const events = SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((event) => event.line);
    return { annotatedStderr, events };
  },

  /**
   * 释放 srt 会话资源
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {
    await SandboxManager.reset();
  },
};
