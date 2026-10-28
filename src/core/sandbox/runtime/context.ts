import { randomUUID } from "node:crypto";
import type { ToolOutput } from "../../tools/types";
import type {
  ApprovalPolicy,
  Approver,
  McpToolMeta,
  SandboxLevel,
  SandboxProvider,
  TierConfig,
} from "../types";
import type { SandboxFileConfig, SandboxRulesConfig } from "../config/schema";
import { appendProjectGrant } from "../config/grants";
import { appendAudit, type AuditEntry } from "../audit";
import { BUILTIN_DANGER_RULES, type DangerRule } from "../policy/danger";
import {
  evaluateCommand,
  evaluateRuleKey,
  type RuleEvaluation,
  type ToolCategory,
} from "../policy/evaluate";
import { parseRule } from "../policy/syntax";
import { buildTierConfig } from "../policy/tier";
import { checkFsRead, checkFsWrite, type FsBoundaryResult } from "./fs-boundary";
import { SerialQueue } from "./serial-queue";

/** 会话级沙箱上下文的构造参数 */
export interface SandboxContextOptions {
  /** 生效的沙箱配置（含 CLI/env 合并结果） */
  config: SandboxFileConfig;
  /** 生效档位 */
  level: SandboxLevel;
  /** 生效审批策略 */
  approval: ApprovalPolicy;
  /** 沙箱 Provider；undefined 表示 fail-closed（bash 可用但执行被拒） */
  provider: SandboxProvider | undefined;
  /** 是否处于可交互环境（TTY）；非交互时 ask 一律拒绝 */
  isInteractive: boolean;
  /** 审批器（交互或测试注入） */
  approver: Approver;
  /** 档位边界配置（fs 工具路径检查用）；缺省按档位与配置以 cwd 为可写根构建 */
  tier?: TierConfig;
  /** 项目根目录（「始终允许」授权落盘到 <cwd>/.tx-cli/config.json；缺省 process.cwd()） */
  cwd?: string;
  /** 项目授权文件路径（缺省 <cwd>/.tx-cli/config.json，测试可注入） */
  projectConfigPath?: string;
  /** 审计日志路径（缺省 ~/.tx-cli/sandbox-audit.jsonl，测试可注入） */
  auditPath?: string;
}

/**
 * 推导授权规则：ask 判定无命中规则可复用时（如 always-ask 策略的档位默认询问）
 * 生成可复用的同类授权粒度——bash 取命令前缀（bash(git status) → bash(git status:*)，
 * 覆盖该命令及其带参变体），其余工具取工具名（整工具放行）
 * @param {string} toolName - 工具名
 * @param {string} ruleKey - 工具生成的规则键
 * @returns {string} 授权规则文本（格式同 rules.allow）
 */
function deriveGrantRule(toolName: string, ruleKey: string): string {
  if (toolName === "bash") {
    const ruleSpec = parseRule(ruleKey)?.pattern;
    return ruleSpec ? `bash(${ruleSpec}:*)` : ruleKey;
  }
  return toolName;
}

/**
 * 会话级沙箱上下文：L2 规则判定 + L3 审批审计 + 串行队列的运行时载体
 * 一个对话会话持有一个实例，随会话结束 dispose
 */
export class SandboxContext {
  /** 生效档位 */
  readonly level: SandboxLevel;
  /** 生效审批策略 */
  readonly approval: ApprovalPolicy;
  /** 沙箱 Provider（undefined 表示 fail-closed） */
  readonly provider: SandboxProvider | undefined;
  /** 是否可交互（TTY） */
  readonly isInteractive: boolean;
  /** bash 工具单命令超时（毫秒） */
  readonly bashTimeoutMs: number;
  /** 档位边界配置（fs 工具路径检查用） */
  readonly tier: TierConfig;
  /** 审批器 */
  private readonly approver: Approver;
  /** 用户规则 + 项目授权 + 会话授权（ask 命中后按 allow 匹配） */
  private readonly rules: SandboxRulesConfig;
  /** 内置危险类目（null 表示整体关闭） */
  private readonly dangerRules: readonly DangerRule[] | null;
  /** 是否写审计日志 */
  private readonly auditEnabled: boolean;
  /** 审计日志路径 */
  private readonly auditPath?: string;
  /** 项目根目录（「始终允许」落盘位置归属） */
  private readonly cwd: string;
  /** 项目授权文件路径（缺省 <cwd>/.tx-cli/config.json） */
  private readonly projectConfigPath?: string;
  /** 串行工具的执行队列（保证 bash 等串行工具不并发执行） */
  private readonly serialQueue = new SerialQueue();

  /**
   * @param {SandboxContextOptions} options - 构造参数
   */
  constructor(options: SandboxContextOptions) {
    this.level = options.level;
    this.approval = options.approval;
    this.provider = options.provider;
    this.isInteractive = options.isInteractive;
    this.bashTimeoutMs = options.config.bash.timeoutMs;
    this.approver = options.approver;
    this.auditEnabled = options.config.audit;
    this.auditPath = options.auditPath;
    this.cwd = options.cwd ?? process.cwd();
    this.projectConfigPath = options.projectConfigPath;
    this.tier =
      options.tier ??
      buildTierConfig(options.level, options.config, this.cwd);
    this.dangerRules = options.config.builtinDangerRules
      ? BUILTIN_DANGER_RULES
      : null;
    // 规则副本：guard 运行期会把 ask 移入 allow、追加会话/持久授权，不污染构造入参
    // 项目空间授权（<cwd>/.tx-cli/config.json）与 mcp.rules 段的 MCP 规则已由装配层合并进 config.rules
    this.rules = {
      allow: [...options.config.rules.allow],
      ask: [...options.config.rules.ask],
      deny: [...options.config.rules.deny],
    };
  }

  /**
   * L2 规则判定入口：bash 工具走复合命令判定，其余工具走规则键判定
   * MCP 工具按 mcp 元信息区分类目：声明 readOnlyHint 的走 mcp-read（默认放行），
   * 其余走 mcp-tool（默认审批）；未携带元信息但规则键为 mcp__ 前缀时按 mcp-tool 兜底
   * @param {string} toolName - 工具名
   * @param {string} ruleKey - 工具生成的规则键
   * @param {readonly string[]} capabilities - 工具能力声明（read-only 档禁网语义判定用）
   * @param {McpToolMeta} mcp - MCP 工具元信息（服务器名与只读标记，非 MCP 工具时缺省）
   * @param {boolean} readOnlySafe - 是否为无副作用只读检索工具（read-only 档 net 判定用）
   * @returns {RuleEvaluation} 判定结果
   */
  evaluate(
    toolName: string,
    ruleKey: string,
    capabilities: readonly string[] = [],
    mcp?: McpToolMeta,
    readOnlySafe = false,
  ): RuleEvaluation {
    if (toolName === "bash") {
      const parsedKey = parseRule(ruleKey);
      const command = parsedKey?.pattern ?? ruleKey;
      return evaluateCommand(
        command,
        this.rules,
        this.dangerRules,
        this.level,
        this.approval,
      );
    }
    const category: ToolCategory = mcp
      ? mcp.readOnly
        ? "mcp-read"
        : "mcp-tool"
      : ruleKey.startsWith("mcp__")
        ? "mcp-tool"
        : "tool";
    return evaluateRuleKey(
      ruleKey,
      this.rules,
      this.level,
      this.approval,
      category,
      capabilities,
      readOnlySafe,
    );
  }

  /**
   * 应用层 fs 读边界：fs 工具是进程内代码不经沙箱进程，读取前对照档位 TierConfig 校验
   * @param {string} path - 待读取的绝对路径
   * @returns {FsBoundaryResult} 拒绝时带中文原因
   */
  checkFsRead(path: string): FsBoundaryResult {
    return checkFsRead(this.level, this.tier, path);
  }

  /**
   * 应用层 fs 写边界：写入前对照档位 TierConfig 校验（allow-only 语义）
   * @param {string} path - 待写入的绝对路径
   * @returns {FsBoundaryResult} 拒绝时带中文原因
   */
  checkFsWrite(path: string): FsBoundaryResult {
    return checkFsWrite(this.level, this.tier, path);
  }

  /**
   * L3 门卫：按 L2 判定放行、拒绝或征询审批
   * MCP 工具审批时额外提供服务器级授权（mcp__server__*），
   * 用户选「本会话/始终允许该服务器」后，同服务器其余工具不再逐个询问
   * @param {string} toolName - 工具名
   * @param {string} ruleKey - 规则键
   * @param {readonly string[]} capabilities - 工具能力声明（read-only 档禁网语义判定用）
   * @param {McpToolMeta} mcp - MCP 工具元信息（服务器名与只读标记，非 MCP 工具时缺省）
   * @param {boolean} readOnlySafe - 是否为无副作用只读检索工具（read-only 档 net 判定用）
   * @returns {Promise<ToolOutput | null>} 拒绝时返回失败输出，放行时返回 null
   */
  async guard(
    toolName: string,
    ruleKey: string,
    capabilities: readonly string[] = [],
    mcp?: McpToolMeta,
    readOnlySafe = false,
  ): Promise<ToolOutput | null> {
    const evaluation = this.evaluate(
      toolName,
      ruleKey,
      capabilities,
      mcp,
      readOnlySafe,
    );
    if (evaluation.decision === "deny") {
      this.recordAudit({
        tool: toolName,
        ruleKey,
        decision: "deny",
      });
      return { ok: false, output: `已拒绝执行：${evaluation.reason}` };
    }
    if (evaluation.decision === "allow") {
      return null;
    }
    // ask 判定：非交互环境按拒绝处理（无法征询即不放行）
    if (!this.isInteractive) {
      this.recordAudit({
        tool: toolName,
        ruleKey,
        decision: "denied-noninteractive",
      });
      return {
        ok: false,
        output: `命令需要审批但当前为非交互环境，已拒绝：${evaluation.reason}`,
      };
    }
    const choice = await this.approver.ask(ruleKey, evaluation.reason, { mcp });
    if (choice.kind === "deny") {
      this.recordAudit({
        tool: toolName,
        ruleKey,
        decision: "denied",
      });
      return { ok: false, output: "用户拒绝了本次命令执行" };
    }
    // 授权粒度：服务器级选择（MCP）落 mcp__server__*；其余优先复用命中的规则原文，
    // always-ask 默认判定无规则可复用时按工具粒度推导
    // （bash 取命令前缀 bash(git status) → bash(git status:*)，其余工具取工具名），
    // 保证「本会话/始终允许」在任何 ask 场景都有可复用的同类粒度
    const serverGrant = mcp ? `mcp__${mcp.serverKey}__*` : undefined;
    const isServerChoice =
      choice.kind === "session-server" || choice.kind === "always-server";
    const grantRule = isServerChoice
      ? serverGrant
      : evaluation.matchedRule || deriveGrantRule(toolName, ruleKey);
    if (
      (choice.kind === "session" || choice.kind === "session-server") &&
      grantRule
    ) {
      // 会话级授权：命中的 ask 规则从 ask 集合移入 allow，同类命令后续不再询问；
      // 服务器级授权不撤销显式 ask 规则（显式规则优先，保持用户配置意图）
      if (choice.kind === "session" && evaluation.matchedRule) {
        this.rules.ask = this.rules.ask.filter(
          (askRule) => askRule !== evaluation.matchedRule,
        );
      }
      this.rules.allow = [...this.rules.allow, grantRule];
    }
    if (
      (choice.kind === "always" || choice.kind === "always-server") &&
      grantRule
    ) {
      // 持久授权落盘到项目空间 .tx-cli/config.json（仅当前项目生效）
      appendProjectGrant(this.cwd, grantRule, this.projectConfigPath);
      this.rules.allow = [...this.rules.allow, grantRule];
    }
    this.recordAudit({
      tool: toolName,
      ruleKey,
      decision: "approved",
    });
    return null;
  }

  /**
   * 沙箱内失败后的升级问询（on-failure 策略专用）
   * @param {string} commandText - 用户可见的命令文本
   * @param {string} reason - 失败/违规说明
   * @returns {Promise<boolean>} 用户批准脱离沙箱重跑时为 true
   */
  async askEscalation(commandText: string, reason: string): Promise<boolean> {
    return this.approver.askEscalation(commandText, reason);
  }

  /**
   * 项目根目录（cwd）的只读暴露
   * 供 MCP roots 等装配方获取授权归属目录，不暴露可变引用
   * @returns {string} 项目根目录绝对路径
   */
  get rootDir(): string {
    return this.cwd;
  }

  /**
   * 当前生效规则的只读快照（含会话授权与持久授权合并后的 allow）
   * 供 /permissions 等只读展示使用；返回副本，外部修改不影响判定
   * @returns {{ allow: string[]; ask: string[]; deny: string[] }} 三段规则原文列表
   */
  listRules(): { allow: string[]; ask: string[]; deny: string[] } {
    return {
      allow: [...this.rules.allow],
      ask: [...this.rules.ask],
      deny: [...this.rules.deny],
    };
  }

  /**
   * 记录一行审计日志（audit 关闭时为空操作）
   * @param {Omit<AuditEntry, "timestamp" | "level" | "approval">} entry - 审计事件（时间戳与档位自动补全）
   * @returns {void}
   */
  recordAudit(entry: Omit<AuditEntry, "timestamp" | "level" | "approval">): void {
    if (!this.auditEnabled) {
      return;
    }
    appendAudit(
      {
        timestamp: new Date().toISOString(),
        level: this.level,
        approval: this.approval,
        ...entry,
      },
      this.auditPath,
    );
  }

  /**
   * 串行执行：把函数排入会话级队列，保证前序完成后再执行后续
   * 前序失败不阻断后续（错误在各自调用方处理）
   * @param {() => Promise<T>} task - 待串行执行的异步函数
   * @returns {Promise<T>} task 的执行结果
   */
  runSerial<T>(task: () => Promise<T>): Promise<T> {
    return this.serialQueue.run(task);
  }

  /**
   * 生成一次执行的唯一关联 ID
   * @returns {string} UUID
   */
  newCommandId(): string {
    return randomUUID();
  }

  /**
   * 释放沙箱会话资源
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {
    await this.provider?.dispose();
  }
}
