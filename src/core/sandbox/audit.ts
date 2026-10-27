import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 审计日志单行结构（JSONL） */
export interface AuditEntry {
  /** 事件时间戳（ISO 字符串） */
  timestamp: string;
  /** 工具名（如 bash） */
  tool: string;
  /** 规则键（如 bash(git push)） */
  ruleKey: string;
  /** 沙箱档位 */
  level: string;
  /** 审批策略 */
  approval: string;
  /** 判定：allow / deny / approved / denied / escalated */
  decision: string;
  /** 是否经用户批准后脱离沙箱重跑 */
  escalated?: boolean;
  /** 命令退出码（执行行才有） */
  exitCode?: number;
  /** 沙箱违规事件（执行行才有） */
  violations?: string[];
}

/**
 * 解析审计日志路径：~/.tx-cli/sandbox-audit.jsonl
 * @returns {string} 审计日志绝对路径
 */
export function resolveAuditPath(): string {
  return join(homedir(), ".tx-cli", "sandbox-audit.jsonl");
}

/**
 * 追加一行审计日志（JSONL）
 * 写入失败仅静默忽略：审计不应阻断工具执行主流程
 * @param {AuditEntry} entry - 审计事件
 * @param {string} path - 审计日志路径（缺省 ~/.tx-cli/sandbox-audit.jsonl，测试可注入）
 * @returns {void}
 */
export function appendAudit(
  entry: AuditEntry,
  path: string = resolveAuditPath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 0o600：审计含命令原文，仅允许当前用户读取
    appendFileSync(path, `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
      flag: "a",
    });
  } catch {
    // 审计写入失败不阻断执行
  }
}
