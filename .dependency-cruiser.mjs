/**
 * dependency-cruiser 依赖守卫（Phase 3：包职责与依赖边界收口）
 * 目标依赖方向：
 *   cli ──> core ──> shared
 *   cli ──> scaffold ──> shared
 *   desktop/server（后续）只复用 core/shared，不依赖 cli
 * 同时禁止任何循环依赖与「深层相对路径绕过包公开出口」的跨包导入
 * @type {import('dependency-cruiser').IConfiguration}
 */
export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止任何循环依赖（包内模块与包之间均不允许）",
      from: {},
      to: { circular: true },
    },
    {
      name: "shared-no-workspace-deps",
      severity: "error",
      comment: "shared 不依赖任何其他 workspace 包",
      from: { path: "^packages/agent-common/" },
      to: { path: "^packages/(agent-core|cli|agent-scaffold|desktop|server)/" },
    },
    {
      name: "core-only-shared",
      severity: "error",
      comment: "core 只依赖 shared，不依赖 cli/scaffold/desktop/server",
      from: { path: "^packages/agent-core/" },
      to: { path: "^packages/(cli|agent-scaffold|desktop|server)/" },
    },
    {
      name: "scaffold-only-shared",
      severity: "error",
      comment: "scaffold 只依赖 shared，不依赖 core/cli",
      from: { path: "^packages/agent-scaffold/" },
      to: { path: "^packages/(agent-core|cli|desktop|server)/" },
    },
    {
      name: "no-cli-from-desktop-server",
      severity: "error",
      comment: "desktop/server 只复用 core/shared，不依赖 cli（预留规则，包落地即生效）",
      from: { path: "^packages/(desktop|server)/" },
      to: { path: "^packages/cli/" },
    },
  ],
  // 说明：「禁止跨包相对路径导入（绕过包公开出口）」由 eslint.config.mjs 的
  // no-restricted-imports 规则承担——depcruise 的 local 依赖类型无法区分
  // tsconfig paths 的包名别名导入与真正的相对路径导入，在 ESLint 按导入串匹配更精确
  options: {
    // 只分析项目内模块：node_modules 中的依赖不展开
    doNotFollow: { path: "node_modules" },
    // TypeScript 类型导入也纳入分析（类型级反向依赖同样破坏边界）
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    exclude: {
      path: "(node_modules|dist|coverage|packages/agent-scaffold/template)",
    },
    reporterOptions: {
      dot: { collapsePattern: "^(packages/[^/]+/[^/]+)" },
      text: { highlightFocused: true },
    },
  },
};
