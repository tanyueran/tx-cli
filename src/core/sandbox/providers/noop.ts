import type {
  SandboxProvider,
  SandboxViolationInfo,
} from "../types";

/**
 * noop Provider：直通实现，不提供任何隔离
 * 用于 danger-full-access 档与「沙箱不可用但用户显式放行」的降级场景；
 * 命令原样执行，隔离完全依赖 L1-L3 的规则与审批层
 */
export const noopProvider: SandboxProvider = {
  name: "noop",

  /**
   * 恒可用：无外部依赖
   * @returns {Promise<boolean>} 恒为 true
   */
  async isAvailable(): Promise<boolean> {
    return true;
  },

  /**
   * 无需初始化
   * @returns {Promise<void>}
   */
  async initialize(): Promise<void> {},

  /**
   * 原样返回命令
   * @param {string} command - 原始命令文本
   * @returns {Promise<string>} 与入参一致
   */
  async wrapCommand(command: string): Promise<string> {
    return command;
  },

  /**
   * 原样返回 stderr，无违规事件
   * @param {string} _commandId - 执行关联 ID（直通实现不使用）
   * @param {string} stderr - 原始 stderr
   * @returns {Promise<SandboxViolationInfo>} 原样 stderr 与空违规列表
   */
  async annotateStderr(
    _commandId: string,
    stderr: string,
  ): Promise<SandboxViolationInfo> {
    return { annotatedStderr: stderr, events: [] };
  },

  /**
   * 无资源需要释放
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {},
};
