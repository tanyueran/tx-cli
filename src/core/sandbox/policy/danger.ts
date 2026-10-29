import { tmpdir } from "node:os";
import { posix } from "node:path";

/**
 * 内置危险命令类目：L2 规则层的高优先级 deny 来源
 * 用户 deny 规则 > 内置危险类目 > ask > allow，即 allow 无法覆盖危险类目，
 * 需要放行时只能整体关闭（sandbox.builtinDangerRules: false）
 */

/** 单条内置危险规则：名称、正则与中文说明 */
export interface DangerRule {
  /** 类目名称（审计与提示用） */
  name: string;
  /** 匹配命令文本段的正则（不区分大小写） */
  pattern: RegExp;
  /** 命中时的中文说明 */
  reason: string;
}

/**
 * 判断删除目标是否明确位于当前工作区或系统临时目录内部
 * 仅接受静态路径；变量、通配符、命令替换与含空格的引用路径保持拒绝（失败关闭）
 * @param {string} rawTarget - rm 命令中的目标参数
 * @returns {boolean} 目标为可安全交由文件系统沙箱兜底的内部路径时为 true
 */
function isContainedRemovalTarget(rawTarget: string): boolean {
  const target =
    (rawTarget.startsWith('"') && rawTarget.endsWith('"')) ||
    (rawTarget.startsWith("'") && rawTarget.endsWith("'"))
      ? rawTarget.slice(1, -1)
      : rawTarget;
  if (!target || /[$`\\*?[\]{}()<>|&;~]/.test(target)) {
    return false;
  }
  const normalized = posix.normalize(target);
  if (posix.isAbsolute(normalized)) {
    return [process.cwd(), tmpdir(), "/tmp", "/private/tmp"].some((root) => {
      const relative = posix.relative(posix.normalize(root), normalized);
      return (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith("../") &&
        !posix.isAbsolute(relative)
      );
    });
  }
  const relativeTarget = normalized.replace(/\/+$/, "");
  return (
    relativeTarget.length > 0 &&
    relativeTarget !== "." &&
    relativeTarget !== ".." &&
    !relativeTarget.startsWith("../")
  );
}

/**
 * 识别目标全部受限的递归删除命令：普通项目产物与临时文件清理由文件系统边界兜底，
 * 不再被一刀切的 rm-recursive 规则误伤；目标解析不完整时保持危险判定
 * @param {string} segment - 复合命令切分并剥离包装后的单个命令段
 * @returns {boolean} 确为 rm 且所有目标均在允许范围内时为 true
 */
function isContainedRecursiveRemoval(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (tokens.shift() !== "rm") {
    return false;
  }
  let parsingOptions = true;
  const targets: string[] = [];
  for (const token of tokens) {
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token.startsWith("-")) {
      continue;
    }
    targets.push(token);
  }
  return targets.length > 0 && targets.every(isContainedRemovalTarget);
}

/**
 * 内置危险类目清单
 * 正则均作用于「复合命令切分后的单个顶层段」的剥离包装形态
 */
export const BUILTIN_DANGER_RULES: readonly DangerRule[] = [
  {
    name: "rm-recursive",
    pattern:
      /(^|\s)rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])[a-zA-Z]*\b|\brm\s+-[a-zA-Z]*[rRf][a-zA-Z]*\b.*\/(\s|$)/,
    reason: "高风险递归/强制删除（根目录、越界或动态路径等），破坏性不可逆",
  },
  {
    name: "sudo-su",
    pattern: /^\s*(sudo|su)\b/,
    reason: "提权执行（sudo/su），绕过沙箱权限边界",
  },
  {
    name: "chmod-777",
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
    reason: "开放全部权限（chmod 777）",
  },
  {
    name: "disk-write",
    pattern: /^\s*(dd|mkfs(\.\w+)?|diskutil)\b/,
    reason: "直接读写磁盘/格式化（dd/mkfs/diskutil）",
  },
  {
    name: "curl-pipe-shell",
    pattern:
      /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\s+-c\b/,
    reason: "下载内容直接管道进 shell 执行（curl|sh），任意代码执行风险",
  },
  {
    name: "git-force-push",
    pattern: /\bgit\s+push\b[^|;&]*\s(--force\b|--force-with-lease\b|-[a-zA-Z]*f)\b/,
    reason: "强制推送（git push -f/--force），覆盖远端历史",
  },
  {
    name: "protected-paths",
    pattern:
      /\b(rm|mv|chmod|chown|tee|truncate)\b[^|;&]*\s((\/etc\/|~\/\.ssh|~\/\.gnupg)|(\S*\/)?\.git(\/|\s|$)|(\S*\/)?\.env\b|(\S*\/)?\.pem\b|(\S*\/)?\.(bashrc|zshrc|profile)\b)/,
    reason: "触碰受保护路径（/etc、~/.ssh、.git、.env、*.pem、shell rc 文件）",
  },
];

/**
 * 在命令段上匹配内置危险类目；目标明确受限的递归清理不命中 rm-recursive，
 * 仍继续检查保护路径等其他类目
 * @param {string} segment - 复合命令切分后的单个顶层段（建议传剥离包装后的形态）
 * @param {readonly DangerRule[]} rules - 参与匹配的危险规则清单
 * @param {boolean} allowContainedRemoval - 是否允许受限递归清理豁免（无隔离档必须传 false）
 * @returns {DangerRule | undefined} 命中的第一条规则，无命中时为 undefined
 */
export function matchDangerRule(
  segment: string,
  rules: readonly DangerRule[] = BUILTIN_DANGER_RULES,
  allowContainedRemoval = false,
): DangerRule | undefined {
  return rules.find(
    (rule) =>
      rule.pattern.test(segment) &&
      (rule.name !== "rm-recursive" ||
        !allowContainedRemoval ||
        !isContainedRecursiveRemoval(segment)),
  );
}
