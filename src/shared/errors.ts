/**
 * 可预期的业务错误：由领域逻辑抛出，顶层统一打印为红色提示并以退出码 1 结束
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * 用户主动取消交互（如 Ctrl+C、Esc）时抛出，顶层不视为异常报错
 */
export class CancelError extends Error {
  constructor(message = "已取消，未做任何修改") {
    super(message);
    this.name = "CancelError";
  }
}
