import { describe, it, expect } from "vitest";
import {
  parseRule,
  matchSpec,
  splitTopLevel,
  stripWrappers,
} from "../src/core/sandbox/policy/syntax";
import {
  evaluateCommand,
  evaluateRuleKey,
} from "../src/core/sandbox/policy/evaluate";
import { BUILTIN_DANGER_RULES } from "../src/core/sandbox/policy/danger";
import type { SandboxRulesConfig } from "../src/core/sandbox/config/schema";

/** 空规则集（全部走档位默认） */
const noRules: SandboxRulesConfig = { allow: [], ask: [], deny: [] };

/**
 * 构造规则集
 * @param {Partial<SandboxRulesConfig>} override - 各段覆盖项
 * @returns {SandboxRulesConfig} 完整规则集
 */
function rules(override: Partial<SandboxRulesConfig> = {}): SandboxRulesConfig {
  return { ...noRules, ...override };
}

describe("parseRule", () => {
  it("解析细粒度规则：Name(spec) 拆出小写名与模式", () => {
    expect(parseRule("Bash(git push:*)")).toEqual({
      toolName: "bash",
      pattern: "git push:*",
      rawText: "Bash(git push:*)",
    });
  });

  it("解析整工具规则：裸 Name 无 spec（别名归一化为内部工具名）", () => {
    expect(parseRule("WebSearch")).toEqual({
      toolName: "web_search",
      rawText: "WebSearch",
    });
  });

  it("规则名别名归一化：Read/ListDir 映射到内部工具名", () => {
    expect(parseRule("Read(/src/**)")?.toolName).toBe("read_file");
    expect(parseRule("ListDir(/tmp)")?.toolName).toBe("list_dir");
    expect(parseRule("READ_FILE(/x)")?.toolName).toBe("read_file");
  });

  it("括号不闭合的非法规则返回 undefined", () => {
    expect(parseRule("Bash(git status")).toBeUndefined();
  });

  it("空串与空白规则返回 undefined", () => {
    expect(parseRule("")).toBeUndefined();
    expect(parseRule("   ")).toBeUndefined();
  });
});

describe("matchSpec", () => {
  it(":* 结尾按前缀匹配（含参数）", () => {
    expect(matchSpec("git push:*", "git push origin main")).toBe(true);
    expect(matchSpec("git push:*", "git pull")).toBe(false);
  });

  it("无通配符按精确匹配", () => {
    expect(matchSpec("git status", "git status")).toBe(true);
    expect(matchSpec("git status", "git status -s")).toBe(false);
  });

  it("含 * 按 glob 匹配", () => {
    expect(matchSpec("git log *", "git log --oneline -5")).toBe(true);
    expect(matchSpec("git log *", "git status")).toBe(false);
  });

  it("路径 glob 匹配", () => {
    expect(matchSpec("/src/**", "/src/a/b/c.ts")).toBe(true);
    expect(matchSpec("/src/**", "/lib/a.ts")).toBe(false);
  });
});

describe("splitTopLevel", () => {
  it("按 && ; | 切分顶层段", () => {
    expect(splitTopLevel("a && b; c | d")).toEqual(["a", "b", "c", "d"]);
  });

  it("引号内的分隔符不切分", () => {
    expect(splitTopLevel("echo 'a && b'")).toEqual(["echo 'a && b'"]);
    expect(splitTopLevel('echo "x | y" && z')).toEqual(['echo "x | y"', "z"]);
  });

  it("空段被过滤", () => {
    expect(splitTopLevel("a &&& b")).toEqual(["a", "b"]);
  });
});

describe("stripWrappers", () => {
  it("剥离环境变量赋值前缀", () => {
    expect(stripWrappers("FOO=1 rm -rf /")).toBe("rm -rf /");
    expect(stripWrappers("A=1 B=2 cmd")).toBe("cmd");
  });

  it("剥离 env/nohup/xargs 包装", () => {
    expect(stripWrappers("env rm -rf /")).toBe("rm -rf /");
    expect(stripWrappers("nohup env X=1 cmd")).toBe("cmd");
    expect(stripWrappers("xargs git push")).toBe("git push");
  });

  it("无包装时原样返回", () => {
    expect(stripWrappers("git status")).toBe("git status");
  });
});

describe("evaluateCommand", () => {
  it("危险类目命中直接拒绝（含包装穿透）", () => {
    const result = evaluateCommand(
      "FOO=1 rm -rf /tmp/x",
      noRules,
      BUILTIN_DANGER_RULES,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("rm-recursive");
  });

  it("sudo 提权被危险类目拒绝", () => {
    const result = evaluateCommand(
      "sudo cat /etc/hosts",
      noRules,
      BUILTIN_DANGER_RULES,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("sudo-su");
  });

  it("builtinDangerRules 关闭后危险命令走档位默认", () => {
    const result = evaluateCommand(
      "rm -rf /tmp/x",
      noRules,
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
  });

  it("用户 deny 规则命中拒绝", () => {
    const result = evaluateCommand(
      "git push origin main",
      rules({ deny: ["Bash(git push:*)"] }),
      BUILTIN_DANGER_RULES,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("Bash(git push:*)");
  });

  it("ask 规则命中进入询问", () => {
    const result = evaluateCommand(
      "git push origin main",
      rules({ ask: ["Bash(git push:*)"] }),
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("ask");
  });

  it("allow 规则精确命中放行", () => {
    const result = evaluateCommand(
      "git status",
      rules({ allow: ["Bash(git status)"] }),
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
  });

  it("allow 不穿透包装：带环境变量前缀的命令不命中精确 allow", () => {
    const result = evaluateCommand(
      "FOO=1 git status",
      rules({ allow: ["Bash(git status)"] }),
      null,
      "read-only",
      "always-ask",
    );
    expect(result.decision).toBe("ask");
  });

  it("复合命令任一段 deny 则整条拒绝", () => {
    const result = evaluateCommand(
      "echo hi && rm -rf /",
      rules({ allow: ["Bash(echo *)"] }),
      BUILTIN_DANGER_RULES,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
  });

  it("复合命令任一段 ask 则整条询问", () => {
    const result = evaluateCommand(
      "echo hi && git push",
      rules({ allow: ["Bash(echo *)"], ask: ["Bash(git push:*)"] }),
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("ask");
  });

  it("复合命令须全部段 allow 才算命中允许", () => {
    const result = evaluateCommand(
      "echo hi && git status",
      rules({ allow: ["Bash(echo *)"] }),
      null,
      "read-only",
      "on-failure",
    );
    // git status 未命中 allow 走档位默认：read-only + on-failure 由沙箱兜底放行
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("沙箱硬边界");
  });

  it("未命中规则时 read-only + on-failure 由沙箱兜底放行", () => {
    const result = evaluateCommand(
      "cat package.json",
      noRules,
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("沙箱");
  });

  it("未命中规则时 always-ask 策略默认询问", () => {
    const result = evaluateCommand(
      "cat package.json",
      noRules,
      null,
      "read-only",
      "always-ask",
    );
    expect(result.decision).toBe("ask");
  });

  it("danger-full-access 档默认放行", () => {
    const result = evaluateCommand(
      "cat package.json",
      noRules,
      null,
      "danger-full-access",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
  });

  it("空命令拒绝", () => {
    const result = evaluateCommand(
      "   ",
      noRules,
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
  });

  it("deny 优先级高于 allow（同一命令双规则命中）", () => {
    const result = evaluateCommand(
      "git push -f origin main",
      rules({
        allow: ["Bash(git push:*)"],
        deny: ["Bash(git push -f:*)"],
      }),
      null,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
  });
});

describe("evaluateRuleKey", () => {
  it("整工具规则匹配同工具键", () => {
    const result = evaluateRuleKey(
      "websearch",
      rules({ allow: ["WebSearch"] }),
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
  });

  it("deny 整工具优先于 allow", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      rules({
        allow: ["mcp__github__create_issue"],
        deny: ["mcp__github__create_issue"],
      }),
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
  });

  it("细粒度规则匹配规则键的 spec", () => {
    const result = evaluateRuleKey(
      "read(/src/a.ts)",
      rules({ allow: ["Read(/src/**)"] }),
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("allow");
  });

  it("spec 不匹配时走档位默认", () => {
    const result = evaluateRuleKey(
      "read(/etc/passwd)",
      rules({ allow: ["Read(/src/**)"] }),
      "read-only",
      "always-ask",
    );
    expect(result.decision).toBe("ask");
  });

  it("非法规则键拒绝", () => {
    const result = evaluateRuleKey(
      "",
      noRules,
      "read-only",
      "on-failure",
    );
    expect(result.decision).toBe("deny");
  });
});

describe("evaluateRuleKey: MCP 类目", () => {
  it("未命中规则时 mcp-tool 类目默认询问（on-failure）", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      noRules,
      "read-only",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("ask");
    // matchedRule 为工具键本身：用户选"本会话/始终允许"时按该工具粒度复用授权
    expect(result.matchedRule).toBe("mcp__github__create_issue");
  });

  it("mcp-tool + never 策略无法征询，fail-closed 拒绝", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      noRules,
      "read-only",
      "never",
      "mcp-tool",
    );
    expect(result.decision).toBe("deny");
  });

  it("mcp-tool + always-ask 默认询问", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      noRules,
      "workspace-write",
      "always-ask",
      "mcp-tool",
    );
    expect(result.decision).toBe("ask");
  });

  it("mcp-tool 在 danger-full-access 档默认放行", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      noRules,
      "danger-full-access",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("allow");
  });

  it("tool 类目（内置工具）未命中规则仍由沙箱兜底放行", () => {
    const result = evaluateRuleKey(
      "web_search",
      noRules,
      "read-only",
      "on-failure",
      "tool",
    );
    expect(result.decision).toBe("allow");
  });

  it("mcp__server__* 通配规则命中该服务器全部工具", () => {
    const result = evaluateRuleKey(
      "mcp__github__create_issue",
      rules({ allow: ["mcp__github__*"] }),
      "read-only",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBe("mcp__github__*");
  });

  it("通配不跨服务器：mcp__github__* 不命中其他服务器工具", () => {
    const result = evaluateRuleKey(
      "mcp__gitlab__create_issue",
      rules({ allow: ["mcp__github__*"] }),
      "read-only",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("ask");
  });

  it("通配仅对 mcp__ 前缀规则名生效，内置工具保持精确匹配", () => {
    const result = evaluateRuleKey(
      "web_search",
      rules({ allow: ["web_*"] }),
      "read-only",
      "always-ask",
      "tool",
    );
    // web_* 不参与名字匹配（通配仅限 mcp__ 前缀），走 always-ask 默认询问
    expect(result.decision).toBe("ask");
  });

  it("ask 通配优先于 allow 精确（deny > ask > allow 链序）", () => {
    const result = evaluateRuleKey(
      "mcp__github__delete_repo",
      rules({
        allow: ["mcp__github__*"],
        ask: ["mcp__github__delete_*"],
      }),
      "read-only",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("ask");
  });

  it("deny 通配优先于 ask 精确", () => {
    const result = evaluateRuleKey(
      "mcp__github__shell",
      rules({
        ask: ["mcp__github__shell"],
        deny: ["mcp__github__*"],
      }),
      "read-only",
      "on-failure",
      "mcp-tool",
    );
    expect(result.decision).toBe("deny");
  });
});

describe("evaluateRuleKey: MCP 只读类目", () => {
  it("未命中规则时 mcp-read 默认放行（on-failure）", () => {
    const result = evaluateRuleKey(
      "mcp__github__get_issue",
      noRules,
      "read-only",
      "on-failure",
      "mcp-read",
      ["net"],
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBe("");
  });

  it("never 策略下 mcp-read 仍默认放行（只读无副作用）", () => {
    const result = evaluateRuleKey(
      "mcp__github__get_issue",
      noRules,
      "workspace-write",
      "never",
      "mcp-read",
      ["net"],
    );
    expect(result.decision).toBe("allow");
  });

  it("always-ask 策略下 mcp-read 仍征询，且按工具粒度复用授权", () => {
    const result = evaluateRuleKey(
      "mcp__github__get_issue",
      noRules,
      "read-only",
      "always-ask",
      "mcp-read",
      ["net"],
    );
    expect(result.decision).toBe("ask");
    expect(result.matchedRule).toBe("mcp__github__get_issue");
  });

  it("显式 deny 规则优先于 mcp-read 默认放行", () => {
    const result = evaluateRuleKey(
      "mcp__github__get_issue",
      rules({ deny: ["mcp__github__get_issue"] }),
      "read-only",
      "on-failure",
      "mcp-read",
      ["net"],
    );
    expect(result.decision).toBe("deny");
  });
});

describe("evaluateRuleKey: capabilities（read-only 档禁网语义）", () => {
  it("read-only 档下声明 net 能力的工具未命中规则默认询问", () => {
    const result = evaluateRuleKey(
      "web_search(天气)",
      rules({ allow: [], ask: [], deny: [] }),
      "read-only",
      "on-failure",
      "tool",
      ["net"],
    );
    expect(result.decision).toBe("ask");
    expect(result.matchedRule).toBe("web_search(天气)");
  });

  it("read-only 档下 net 工具 + never 策略默认拒绝（fail-closed）", () => {
    const result = evaluateRuleKey(
      "web_search(天气)",
      rules({ allow: [], ask: [], deny: [] }),
      "read-only",
      "never",
      "tool",
      ["net"],
    );
    expect(result.decision).toBe("deny");
  });

  it("workspace-write 档下 net 工具未命中规则仍默认放行（由沙箱边界兜底）", () => {
    const result = evaluateRuleKey(
      "web_search(天气)",
      rules({ allow: [], ask: [], deny: [] }),
      "workspace-write",
      "on-failure",
      "tool",
      ["net"],
    );
    expect(result.decision).toBe("allow");
  });

  it("allow 规则命中优先于 net 默认审批", () => {
    const result = evaluateRuleKey(
      "web_search(天气)",
      rules({ allow: ["WebSearch"], ask: [], deny: [] }),
      "read-only",
      "on-failure",
      "tool",
      ["net"],
    );
    expect(result.decision).toBe("allow");
  });

  it("未声明 net 能力的工具不受禁网默认审批影响", () => {
    const result = evaluateRuleKey(
      "read_file(/tmp/a)",
      rules({ allow: [], ask: [], deny: [] }),
      "read-only",
      "on-failure",
      "tool",
      ["fs.read"],
    );
    expect(result.decision).toBe("allow");
  });
});
