import type { Command } from "commander";
import { existsSync } from "node:fs";
import pico from "picocolors";
import { copyPath, resolveCopyTarget } from "../../core/copy";
import { resolveFromCwd } from "../../shared/paths";
import { CancelError } from "../../shared/errors";
import { askConfirm } from "../../shared/prompt";

/** copy 命令的选项 */
interface CopyCommandOptions {
  /** 排除规则列表，可多次传入 */
  filter: string[];
  /** 目标已存在时是否直接覆盖（跳过交互确认） */
  force?: boolean;
}

/**
 * 收集可重复传入的选项值
 * @param {string} value - 本次传入的值
 * @param {string[]} previous - 已收集的值列表
 * @returns {string[]} 追加后的值列表
 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * 注册 copy 命令：复制文件或目录，支持按规则排除部分文件
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerCopyCommand(program: Command): void {
  program
    .command("copy <src> <dest>")
    .description("复制文件或目录，支持过滤某些文件")
    .option(
      "-f, --filter <pattern>",
      "排除匹配的文件/目录，可多次传入（glob 语法，基于源目录的相对路径）",
      collect,
      []
    )
    .option("-F, --force", "目标已存在时直接覆盖，不再交互确认")
    .action(async (srcArg: string, destArg: string, options: CopyCommandOptions) => {
      const src = resolveFromCwd(srcArg);
      const dest = resolveFromCwd(destArg);

      // 先解析出真实目标路径，用于判断是否需要覆盖确认（源不存在时此处即报错）
      const targetPath = await resolveCopyTarget(src, dest);
      if (existsSync(targetPath) && !options.force) {
        const overwrite = await askConfirm(
          `目标路径 ${targetPath} 已存在，继续将覆盖其中的同名文件，确认吗？`
        );
        if (!overwrite) {
          throw new CancelError();
        }
      }

      const result = await copyPath({
        src,
        dest,
        filters: options.filter,
      });

      if (result.copiedFiles === 0) {
        console.log(
          pico.yellow(
            `没有文件被复制：${src} -> ${result.targetPath}（可能全部被过滤规则排除）`
          )
        );
        return;
      }

      console.log(pico.green(`复制完成：${src} -> ${result.targetPath}`));
      console.log(
        pico.green(
          `复制 ${result.copiedFiles} 个文件，跳过 ${result.skippedEntries} 项`
        )
      );
    });
}
