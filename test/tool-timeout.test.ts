import { describe, it, expect } from "vitest";
import {
  pauseToolTimeout,
  resumeToolTimeout,
  withPausableTimeout,
} from "../src/shared/timeout";
import { SandboxContext } from "../src/core/sandbox/runtime/context";
import { DEFAULT_SANDBOX_CONFIG } from "../src/core/sandbox/config/schema";
import { noopProvider } from "../src/core/sandbox/providers/backends/noop";
import type {
  ApprovalChoice,
  Approver,
} from "../src/core/sandbox/types";

/**
 * 等待指定毫秒
 * @param {number} ms - 等待时长
 * @returns {Promise<void>} 等待完成
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withPausableTimeout", () => {
  it("任务超出时限时按消息拒绝", async () => {
    await expect(
      withPausableTimeout(() => sleep(200), 30, "工具执行超时（0.03s）"),
    ).rejects.toThrow("工具执行超时");
  });

  it("任务在时限内完成时正常返回", async () => {
    const result = await withPausableTimeout(
      () => Promise.resolve("done"),
      1_000,
      "超时",
    );
    expect(result).toBe("done");
  });

  it("暂停期间不消耗时限：等待超过原时限仍不触发超时", async () => {
    const result = await withPausableTimeout(
      async () => {
        pauseToolTimeout();
        await sleep(150); // 远超 50ms 时限，但计时已暂停
        resumeToolTimeout();
        await sleep(10); // 恢复后剩余时限（约 40ms）内完成
        return "ok";
      },
      50,
      "超时",
    );
    expect(result).toBe("ok");
  });

  it("暂停后恢复，剩余时限耗尽仍会超时", async () => {
    const task = withPausableTimeout(
      async () => {
        pauseToolTimeout();
        await sleep(30);
        resumeToolTimeout();
        await sleep(120); // 超过剩余时限（约 20ms）
        return "ok";
      },
      50,
      "超时",
    );
    await expect(task).rejects.toThrow("超时");
  });

  it("暂停期间任务完成则正常返回且不触发超时", async () => {
    const result = await withPausableTimeout(
      async () => {
        pauseToolTimeout();
        await sleep(20);
        return "ok";
      },
      1_000,
      "超时",
    );
    expect(result).toBe("ok");
  });

  it("无工具执行上下文时任务内的暂停/恢复为 no-op（不抛错、不影响计时）", async () => {
    pauseToolTimeout();
    resumeToolTimeout();
    const task = withPausableTimeout(
      async () => {
        await sleep(80);
        return "ok";
      },
      30,
      "超时",
    );
    await expect(task).rejects.toThrow("超时");
  });

  it("并发执行链各自持有控制器：一条链暂停不影响另一条链的超时", async () => {
    const paused = withPausableTimeout(
      async () => {
        pauseToolTimeout();
        await sleep(120);
        resumeToolTimeout();
        return "paused-ok";
      },
      50,
      "A 超时",
    );
    const plain = withPausableTimeout(
      async () => {
        await sleep(80);
        return "plain-timeout-expected";
      },
      30,
      "B 超时",
    );
    // allSettled 同时监听两个结果，避免一方先拒绝时触发 unhandled rejection
    const [pausedResult, plainResult] = await Promise.allSettled([paused, plain]);
    expect(pausedResult).toEqual({ status: "fulfilled", value: "paused-ok" });
    expect(plainResult.status).toBe("rejected");
    expect(
      (plainResult as PromiseRejectedResult).reason.message,
    ).toContain("B 超时");
  });
});

describe("审批问询不消耗工具超时（guard / askEscalation 集成）", () => {
  /** 可编程假审批器：ask 延迟指定毫秒后返回预设选择 */
  class SlowApprover implements Approver {
    /**
     * @param {ApprovalChoice} choice - 预设应答
     * @param {number} delayMs - ask 响应延迟（模拟用户思考）
     */
    constructor(
      private readonly choice: ApprovalChoice,
      private readonly delayMs: number,
    ) {}

    /**
     * 延迟后返回预设选择
     * @returns {Promise<ApprovalChoice>} 预设选择
     */
    async ask(): Promise<ApprovalChoice> {
      await sleep(this.delayMs);
      return this.choice;
    }

    /**
     * 延迟后批准升级
     * @returns {Promise<boolean>} 预设应答
     */
    async askEscalation(): Promise<boolean> {
      await sleep(this.delayMs);
      return true;
    }
  }

  /**
   * 构造测试用沙箱上下文（ask 规则触发审批）
   * @param {Approver} approver - 审批器
   * @returns {SandboxContext} 上下文实例
   */
  function makeContext(approver: Approver): SandboxContext {
    return new SandboxContext({
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        rules: { allow: [], ask: ["Bash(git status)"], deny: [] },
      },
      level: "read-only",
      approval: "on-failure",
      provider: noopProvider,
      isInteractive: true,
      approver,
      cwd: "/tmp",
      auditPath: "/tmp/nonexistent-audit.jsonl",
    });
  }

  it("用户思考时间超过工具时限也不触发超时：迟到授权竞态消除", async () => {
    // 审批等待 150ms（远超 50ms 工具时限），guard 内暂停计时后应正常放行
    const context = makeContext(new SlowApprover({ kind: "once" }, 150));
    const result = await withPausableTimeout(
      () => context.guard("bash", "bash(git status)"),
      50,
      "工具执行超时",
    );
    expect(result).toBeNull();
  });

  it("升级问询（askEscalation）同样不消耗工具超时", async () => {
    const context = makeContext(new SlowApprover({ kind: "deny" }, 150));
    const result = await withPausableTimeout(
      () => context.askEscalation("bash(git push)", "命令被沙箱拦截导致失败"),
      50,
      "工具执行超时",
    );
    expect(result).toBe(true);
  });

  it("审批放行后的真实执行仍受超时约束", async () => {
    const context = makeContext(new SlowApprover({ kind: "once" }, 1));
    const task = withPausableTimeout(
      async () => {
        const denial = await context.guard("bash", "bash(git status)");
        expect(denial).toBeNull();
        await sleep(120); // 审批通过后的慢执行
        return "ok";
      },
      50,
      "工具执行超时",
    );
    await expect(task).rejects.toThrow("工具执行超时");
  });
});
