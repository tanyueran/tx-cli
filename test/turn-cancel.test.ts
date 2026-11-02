import { describe, it, expect } from "vitest";
import {
  markTurnCancelled,
  runWithTurnCancellation,
  throwIfTurnCancelled,
} from "../src/shared/turn-cancel";

describe("runWithTurnCancellation", () => {
  it("顶层调用创建全新取消状态", async () => {
    await runWithTurnCancellation(async () => {
      expect(() => throwIfTurnCancelled()).not.toThrow();
      markTurnCancelled();
      expect(() => throwIfTurnCancelled()).toThrow();
    });
  });

  it("嵌套调用复用外层状态：内层标记取消对外层可见", async () => {
    await runWithTurnCancellation(async () => {
      await runWithTurnCancellation(async () => {
        // 子 Agent 的嵌套 loop 不新建状态：与主回合共享同一取消标记
        expect(() => throwIfTurnCancelled()).not.toThrow();
        markTurnCancelled();
      });
      // 子 Agent 内的取消即整轮取消：外层安全点同样短路
      expect(() => throwIfTurnCancelled()).toThrow();
    });
  });

  it("外层已取消时嵌套调用的安全点同样短路（主回合取消能拦住子 Agent）", async () => {
    await runWithTurnCancellation(async () => {
      markTurnCancelled();
      // 主回合取消后，子 Agent 的排队任务与审批安全点必须短路，不能孤儿续跑
      await expect(
        runWithTurnCancellation(async () => {
          throwIfTurnCancelled();
        }),
      ).rejects.toThrow();
    });
  });

  it("两次顶层调用互不影响（REPL 多轮之间隔离）", async () => {
    await runWithTurnCancellation(async () => {
      markTurnCancelled();
    });
    await runWithTurnCancellation(async () => {
      expect(() => throwIfTurnCancelled()).not.toThrow();
    });
  });
});
