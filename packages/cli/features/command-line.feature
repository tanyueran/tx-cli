# language: zh-CN
功能: 命令行入口与参数约束
  作为命令行用户
  我希望获得一致的命令发现、参数校验和退出状态
  以便在终端或脚本中可靠地使用 tx-cli

  背景:
    假如 用户可以在终端中运行 tx-cli

  场景: 总帮助列出全部已注册命令
    当 用户执行 tx-cli --help
    那么 命令应以退出码 0 结束
    而且 输出应按以下顺序列出命令:
      | create      |
      | add         |
      | copy        |
      | server      |
      | git-rename  |
      | commit-fix  |
      | chat        |
      | agent       |
    而且 输出应包含全局版本选项和帮助选项

  场景大纲: 查看命令级帮助
    当 用户执行 <命令行>
    那么 命令应以退出码 0 结束
    而且 输出应包含 <命令名> 的用法说明
    而且 输出应包含选项 <选项>

    例子:
      | 命令行             | 命令名 | 选项      |
      | tx-cli help chat   | chat   | --think   |
      | tx-cli agent --help| agent  | --sandbox |
      | tx-cli copy --help | copy   | --filter  |

  场景大纲: 查看当前版本
    当 用户执行 <命令行>
    那么 命令应以退出码 0 结束
    而且 输出应包含当前版本号

    例子:
      | 命令行           |
      | tx-cli -V        |
      | tx-cli --version |

  场景大纲: 拒绝无法识别的命令或选项
    当 用户执行 <命令行>
    那么 命令应以退出码 1 结束
    而且 错误输出应指出无法识别的命令或选项
    而且 不应执行对应的业务操作

    例子:
      | 命令行                              |
      | tx-cli unknown                      |
      | tx-cli chat --unknown 问题          |
      | tx-cli copy --unknown a.txt b.txt   |

  场景大纲: 缺少必填位置参数时停止执行
    当 用户执行 <命令行>
    那么 命令应以退出码 1 结束
    而且 错误输出应提示缺少必填参数
    而且 不应执行对应的业务操作

    例子:
      | 命令行                       |
      | tx-cli copy source.txt       |
      | tx-cli git-rename old.ts     |
      | tx-cli commit-fix            |

  场景大纲: 选项缺值或枚举值非法时提前失败
    当 用户执行 <命令行>
    那么 命令应以退出码 1 结束
    而且 错误输出应说明无效选项值或缺少选项值
    而且 不应启动服务、会话或文件操作

    例子:
      | 命令行                                      |
      | tx-cli agent --sandbox invalid 任务         |
      | tx-cli agent --approval sometimes 任务      |
      | tx-cli agent --sandbox-missing ignore 任务  |
      | tx-cli server --port                        |

  场景: 可预期的业务错误以失败状态退出
    假如 当前目录不存在 missing.txt
    当 用户执行 tx-cli copy missing.txt out.txt
    那么 命令应以退出码 1 结束
    而且 错误输出应提示源路径不存在
    而且 不应创建 out.txt

  场景: 用户主动取消覆盖属于正常退出
    假如 当前目录的 source.txt 与 target.txt 内容不同
    当 用户执行 tx-cli copy source.txt target.txt
    而且 用户在覆盖确认中选择不覆盖
    那么 命令应以退出码 0 结束
    而且 target.txt 的内容应保持不变
