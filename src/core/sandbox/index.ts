/**
 * core/sandbox 模块的桶导出：沙箱装配统一入口
 * 说明：模块内部文件互相引用时仍直接走具体文件
 */
export type {
  ApprovalChoice,
  ApprovalPolicy,
  Approver,
  RuleDecision,
  SandboxLevel,
  SandboxProvider,
  SandboxViolationInfo,
  TierConfig,
} from "./types";
export {
  SANDBOX_LEVELS,
  APPROVAL_POLICIES,
  DEFAULT_SANDBOX_CONFIG,
} from "./config/schema";
export type {
  SandboxBashConfig,
  SandboxConfigResult,
  SandboxFileConfig,
  SandboxFsConfig,
  SandboxNetworkConfig,
  SandboxRulesConfig,
} from "./config/schema";
export { loadSandboxConfig } from "./config/load";
export { appendProjectGrant } from "./config/grants";
export {
  parseRule,
  matchSpec,
  splitTopLevel,
  stripWrappers,
  normalizeCommand,
} from "./policy/syntax";
export type { ParsedRule } from "./policy/syntax";
export { evaluateCommand, evaluateRuleKey } from "./policy/evaluate";
export type { RuleEvaluation } from "./policy/evaluate";
export { BUILTIN_DANGER_RULES, matchDangerRule } from "./policy/danger";
export type { DangerRule } from "./policy/danger";
export {
  buildTierConfig,
  DEFAULT_DENY_READ,
  DEFAULT_DENY_WRITE,
} from "./policy/tier";
export { expandHome, matchPathPattern } from "./policy/path-match";
export { appendAudit } from "./audit";
export type { AuditEntry } from "./audit";
export { getProvider, listProviderNames } from "./providers/registry";
export { landlockProvider } from "./providers/backends/landlock";
export { SandboxContext } from "./runtime/context";
export type { SandboxContextOptions } from "./runtime/context";
export { interactiveApprover, detectInteractive } from "./runtime/approver";
export { createSandboxContext } from "./assembly";
export type { SandboxCliOptions } from "./assembly";
