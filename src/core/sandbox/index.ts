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
  loadSandboxConfig,
  DEFAULT_SANDBOX_CONFIG,
  resolveProjectConfigPath,
  readProjectGrants,
  appendProjectGrant,
} from "./config";
export type {
  SandboxBashConfig,
  SandboxConfigResult,
  SandboxFileConfig,
  SandboxFsConfig,
  SandboxNetworkConfig,
  SandboxRulesConfig,
} from "./config";
export {
  parseRule,
  matchSpec,
  splitTopLevel,
  stripWrappers,
  normalizeCommand,
  evaluateCommand,
  evaluateRuleKey,
} from "./rules";
export type { ParsedRule, RuleEvaluation } from "./rules";
export { BUILTIN_DANGER_RULES, matchDangerRule } from "./danger-rules";
export type { DangerRule } from "./danger-rules";
export {
  buildTierConfig,
  expandHome,
  matchPathPattern,
  DEFAULT_DENY_READ,
  DEFAULT_DENY_WRITE,
} from "./defaults";
export {
  appendAudit,
} from "./audit";
export type { AuditEntry } from "./audit";
export { getProvider, listProviderNames } from "./provider";
export { landlockProvider } from "./providers/landlock";
export { SandboxContext, interactiveApprover, detectInteractive } from "./gate";
export type { SandboxContextOptions } from "./gate";
export { createSandboxContext } from "./assembly";
export type { SandboxCliOptions } from "./assembly";
