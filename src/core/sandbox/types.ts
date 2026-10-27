/**
 * 沙箱核心类型：档位、审批策略、档位配置、Provider 接口与判定结果
 * 三档沙箱与审批策略正交：档位决定「能力边界」，审批策略决定「失败后的处置」
 */

/** 沙箱隔离档位（标准三档权限模型） */
export type SandboxLevel = "read-only" | "workspace-write" | "danger-full-access";

/** 审批策略：ask 命中后与沙箱内失败后的处置方式 */
export type ApprovalPolicy = "always-ask" | "on-failure" | "never";

/** 沙箱不可用时的处置：allow 降级为无隔离执行（规则与审批仍生效）/ deny 失败关闭（默认） */
export type SandboxMissingAction = "allow" | "deny";

/** 权限规则的判定结果 */
export type RuleDecision = "allow" | "deny" | "ask";

/**
 * 档位配置：映射到具体沙箱 Provider 的隔离参数
 * 文件系统写入为 allow-only（仅 allowWrite 内可写），读取为 deny-then-allow（denyRead 优先）
 */
export interface TierConfig {
  /** 对应的沙箱档位 */
  level: SandboxLevel;
  /** 禁止读取的路径模式（展开 ~） */
  denyRead: string[];
  /** 允许写入的路径（allow-only，空数组 = 全禁写） */
  allowWrite: string[];
  /** 在 allowWrite 之内仍禁止写入的路径模式 */
  denyWrite: string[];
  /** 允许访问的网络域名（空数组 = 全禁网） */
  allowedDomains: string[];
  /** 明确禁止的网络域名 */
  deniedDomains: string[];
}

/** 沙箱执行违规信息：Provider 对命令的标注与原始事件 */
export interface SandboxViolationInfo {
  /** 标注到 stderr 的完整说明（含违规行） */
  annotatedStderr: string;
  /** 违规事件原文（审计用） */
  events: string[];
}

/**
 * 沙箱 Provider 接口：具体沙箱实现的可插拔抽象
 * 实现方（如 srt、noop、未来的 Landlock）只需覆盖命令包装与违规回传，
 * 上层（规则判定、审批、审计）不感知具体沙箱技术
 */
export interface SandboxProvider {
  /** Provider 名称（配置 sandbox.provider 按此选择） */
  readonly name: string;
  /**
   * 探测当前环境是否可用（平台支持、依赖齐全）
   * @returns {Promise<boolean>} 可用时为 true
   */
  isAvailable(): Promise<boolean>;
  /**
   * 初始化沙箱会话（按档位配置建立隔离边界）
   * @param {TierConfig} tierConfig - 档位配置
   * @returns {Promise<void>}
   */
  initialize(tierConfig: TierConfig): Promise<void>;
  /**
   * 包装命令：把原命令改写为在沙箱内执行的形式
   * @param {string} command - 原始命令文本
   * @param {{ commandId: string; commandText: string }} wrapOptions - 调用选项
   * @param {string} wrapOptions.commandId - 本次执行的唯一关联 ID（违规归因用）
   * @param {string} wrapOptions.commandText - 用户可见的命令文本（展示与审计用）
   * @returns {Promise<string>} 包装后的可执行命令
   */
  wrapCommand(
    command: string,
    wrapOptions: { commandId: string; commandText: string },
  ): Promise<string>;
  /**
   * 标注 stderr：把沙箱违规信息追加到原始 stderr 末尾，回传模型自纠
   * @param {string} commandId - 执行关联 ID（与 wrapCommand 一致）
   * @param {string} stderr - 原始 stderr 输出
   * @returns {Promise<SandboxViolationInfo>} 标注结果与违规事件列表
   */
  annotateStderr(
    commandId: string,
    stderr: string,
  ): Promise<SandboxViolationInfo>;
  /**
   * 释放沙箱会话资源（会话结束时调用）
   * @returns {Promise<void>}
   */
  dispose(): Promise<void>;
}

/**
 * MCP 工具元信息：由适配层从远端工具定义提取，供沙箱判定与审批使用
 * 服务器名用于生成服务器级授权规则（mcp__<server>__*），
 * 只读标记来自 MCP 协议的 annotations.readOnlyHint，未标注时为 false（保守口径）
 */
export interface McpToolMeta {
  /** MCP 服务器名（配置中的原始键名，审批提示展示用） */
  serverName: string;
  /** 规则键中的服务器段（净化后，与 mcp__ 工具名保持同一口径，授权规则用） */
  serverKey: string;
  /** 是否为只读工具（readOnlyHint 为 true 且 destructiveHint 非 true） */
  readOnly: boolean;
}

/** 审批问询的上下文：区分普通命令与 MCP 工具，决定展示哪些授权粒度 */
export interface ApprovalAskContext {
  /** MCP 工具元信息（非 MCP 工具时为 undefined） */
  mcp?: McpToolMeta;
}

/**
 * 审批选择：用户对 ask 判定的回答
 * session-server / always-server 为 MCP 专属：按整个服务器（mcp__server__*）授权，
 * 避免同一服务器多个工具逐个询问
 */
export type ApprovalChoice =
  | { kind: "once" }
  | { kind: "session" }
  | { kind: "always" }
  | { kind: "session-server" }
  | { kind: "always-server" }
  | { kind: "deny" };

/**
 * 审批器：ask 判定发生时向用户征询处置
 * 交互实现走 prompts，测试可注入假实现
 */
export interface Approver {
  /**
   * 征询审批
   * @param {string} ruleKey - 触发审批的规则键（如 bash(git push)）
   * @param {string} reason - 判定说明（命中规则或档位默认）
   * @param {ApprovalAskContext} context - 问询上下文（MCP 工具时携带服务器与只读信息）
   * @returns {Promise<ApprovalChoice>} 用户选择
   */
  ask(
    ruleKey: string,
    reason: string,
    context?: ApprovalAskContext,
  ): Promise<ApprovalChoice>;
  /**
   * 沙箱内失败后的升级问询（on-failure 策略专用）
   * @param {string} commandText - 用户可见的命令文本
   * @param {string} reason - 失败/违规说明
   * @returns {Promise<boolean>} 批准脱离沙箱重跑时为 true
   */
  askEscalation(commandText: string, reason: string): Promise<boolean>;
}
