import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 审计日志单行结构（JSONL） */
export interface AuditEntry {
  /** 事件时间戳（ISO 字符串） */
  ts: string;
  /** 工具名（如 bash） */
  tool: string;
  /** 规则键（如 bash(git push)） */
  ruleKey: string;
  /** 沙箱档位 */
  tier: string;
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

/** 解析 grants 文件的结构 */
interface GrantsFile {
  /** 「始终允许」的规则（格式同 rules.allow） */
  allow: string[];
}

/**
 * 解析 grants 文件路径：~/.tx-cli/sandbox-grants.json
 * @returns {string} grants 文件绝对路径
 */
export function resolveGrantsPath(): string {
  return join(homedir(), ".tx-cli", "sandbox-grants.json");
}

/**
 * 解析审计日志路径：~/.tx-cli/sandbox-audit.jsonl
 * @returns {string} 审计日志绝对路径
 */
export function resolveAuditPath(): string {
  return join(homedir(), ".tx-cli", "sandbox-audit.jsonl");
}

/**
 * 读取持久化授权（「始终允许」的规则）
 * 文件不存在或损坏时返回空列表（首次使用即此状态）
 * @param {string} path - grants 文件路径（缺省 ~/.tx-cli/sandbox-grants.json，测试可注入）
 * @returns {string[]} 授权规则列表
 */
export function readGrants(path: string = resolveGrantsPath()): string[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return [];
    }
    const { allow } = parsed as Record<string, unknown>;
    if (!Array.isArray(allow) || allow.some((a) => typeof a !== "string")) {
      return [];
    }
    return allow as string[];
  } catch {
    return [];
  }
}

/**
 * 追加一条「始终允许」授权到 grants 文件（不存在则创建）
 * 重复规则不重复写入
 * @param {string} rule - 规则文本（格式同 rules.allow，如 bash(git status)）
 * @param {string} path - grants 文件路径（缺省 ~/.tx-cli/sandbox-grants.json，测试可注入）
 * @returns {void}
 */
export function appendGrant(rule: string, path: string = resolveGrantsPath()): void {
  const existing = readGrants(path);
  if (existing.includes(rule)) {
    return;
  }
  const content: GrantsFile = { allow: [...existing, rule] };
  mkdirSync(dirname(path), { recursive: true });
  // 0o600：授权文件相当于权限放行凭据，仅允许当前用户读写
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, {
    mode: 0o600,
  });
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
