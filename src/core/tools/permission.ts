import type { SandboxContext } from "../sandbox/runtime/context";
import type { Tool, ToolOutput, ToolPermission } from "./types";

/**
 * 用权限门卫包装工具：声明了 permission 的工具先经 L2 规则判定 + L3 审批
 * 声明了 paths 且 capability 含 fs.read/fs.write 时，规则放行后按档位 TierConfig 做路径边界检查
 * （fs 工具是进程内代码不经沙箱进程，边界检查在此层兜底）；
 * 串行工具（如 bash）的「判定 + 执行」全程在会话级队列中依次进行；
 * 未声明 permission 的工具原样返回（零破坏，支持渐进迁移）
 * @param {Tool} tool - 待包装的工具
 * @param {SandboxContext} sandbox - 会话级沙箱上下文
 * @returns {Tool} 包装后的工具（模型可见定义不变，仅 execute 被门卫拦截）
 */
export function wrapToolWithPermission(
  tool: Tool,
  sandbox: SandboxContext,
): Tool {
  if (!tool.permission) {
    return tool;
  }
  const permission = tool.permission;
  return {
    ...tool,
    /**
     * 门卫执行：先规则判定，再档位边界，最后执行
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 门卫拒绝时返回失败说明，放行时返回工具执行结果
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const invoke = async (): Promise<ToolOutput> => {
        const ruleKey = permission.ruleKey(args);
        const blocked = await sandbox.guard(
          tool.name,
          ruleKey,
          permission.capabilities,
          permission.mcp,
        );
        if (blocked) {
          return blocked;
        }
        const fsBlocked = checkFsBoundary(
          permission,
          tool.name,
          sandbox,
          args,
          ruleKey,
        );
        if (fsBlocked) {
          return fsBlocked;
        }
        return tool.execute(args);
      };
      return permission.serial
        ? sandbox.runSerial(invoke)
        : invoke();
    },
  };
}

/**
 * 档位 fs 边界检查：对 permission.paths 声明的路径按 read/write capability 校验
 * @param {ToolPermission} permission - 工具的权限声明
 * @param {string} toolName - 工具名（审计用）
 * @param {SandboxContext} sandbox - 会话级沙箱上下文
 * @param {Record<string, unknown>} args - 模型给出的参数
 * @param {string} ruleKey - 本次调用的规则键（审计用）
 * @returns {ToolOutput | null} 命中边界即返回失败输出；无需检查或全部通过时为 null
 */
function checkFsBoundary(
  permission: ToolPermission,
  toolName: string,
  sandbox: SandboxContext,
  args: Record<string, unknown>,
  ruleKey: string,
): ToolOutput | null {
  if (!permission.paths) {
    return null;
  }
  const wantsRead = permission.capabilities.includes("fs.read");
  const wantsWrite = permission.capabilities.includes("fs.write");
  if (!wantsRead && !wantsWrite) {
    return null;
  }
  for (const path of permission.paths(args)) {
    const verdict = wantsWrite
      ? sandbox.checkFsWrite(path)
      : sandbox.checkFsRead(path);
    if (!verdict.allowed) {
      sandbox.recordAudit({
        tool: toolName,
        ruleKey,
        decision: "deny",
        violations: [verdict.reason ?? "路径越界"],
      });
      return { ok: false, output: `已拒绝访问：${verdict.reason}` };
    }
  }
  return null;
}
