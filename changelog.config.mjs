import createPreset from "conventional-changelog-conventionalcommits";

/**
 * changelog 提交类型与分组标题的映射。
 * 与 commitlint.config.mjs 中的 type-enum 保持一致，避免提交被预设过滤掉；
 * 某个类型若不想出现在 changelog 中，在其配置项上追加 `hidden: true` 即可。
 * @type {{ type: string, section: string, hidden?: boolean }[]}
 */
const TYPES = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "refactor", section: "Code Refactoring" },
  { type: "docs", section: "Documentation" },
  { type: "style", section: "Styles" },
  { type: "test", section: "Tests" },
  { type: "build", section: "Build System" },
  { type: "ci", section: "Continuous Integration" },
  { type: "chore", section: "Miscellaneous Chores" },
  { type: "revert", section: "Reverts" },
  // 发布提交（release: vX.Y.Z）与版本标题重复，默认隐藏；
  // 如需展示，去掉 hidden 即可。
  { type: "release", section: "Releases", hidden: true },
];

/**
 * conventional-changelog 的自定义预设。
 * 由 `-n ./changelog.config.mjs` 加载，用于覆盖默认隐藏的提交类型。
 * @returns {Promise<object>} 包含 commits、parser、writer 的预设配置对象
 */
export default createPreset({ types: TYPES });
