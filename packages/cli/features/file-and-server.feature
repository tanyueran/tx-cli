# language: zh-CN
功能: 文件、静态服务与 Git 辅助命令
  作为项目开发者
  我希望用统一命令完成复制、静态服务、重命名和修复提交
  以便安全地执行常见项目操作

  场景大纲: 按源类型和目标状态确定复制位置
    假如 当前目录存在内容为 new 的源文件 source.txt
    而且 当前目录存在源目录 src，其中包含内容为 new 的 keep.txt
    而且 当前目录存在空目录 out
    而且 当前目录存在内容为 old 的 existing.txt
    当 用户执行 <命令>
    那么 文件 <结果路径> 应存在且内容为 new
    而且 输出应报告复制完成及文件统计

    例子:
      | 命令                                       | 结果路径          |
      | tx-cli copy source.txt renamed.txt --force | renamed.txt       |
      | tx-cli copy source.txt out --force         | out/source.txt    |
      | tx-cli copy src backup --force             | backup/keep.txt   |
      | tx-cli copy src out --force                | out/src/keep.txt  |
      | tx-cli copy source.txt existing.txt --force| existing.txt      |

  场景: 覆盖确认后复制并排除匹配内容
    假如 源目录 src 包含普通文件、日志、二进制文件、可执行脚本和 node_modules 子目录
    而且 目标目录 backup/src 已存在同名普通文件
    当 用户执行 tx-cli copy src backup --filter "**/*.log" --filter "node_modules/**"
    而且 用户在覆盖确认中选择继续
    那么 普通文件、二进制文件和可执行脚本应复制到 backup/src
    而且 二进制内容与原文件逐字节一致
    而且 可执行脚本的权限位应与原文件一致
    而且 所有日志文件及整个 node_modules 子目录均应被排除
    而且 输出应报告复制文件数和跳过条目数

  场景: 静态服务器提供文件、自定义响应头和未找到响应
    假如 服务目录 public 中存在内容为 hello 的 hello.txt
    而且 用户选择了一个空闲端口
    当 用户在主机 127.0.0.1、该端口和 public 目录上启动 server
    而且 用户设置自定义响应头 X-Test-Header 为 tx-cli
    那么 启动信息应显示访问地址、服务目录和停止方式
    当 用户请求 /hello.txt
    那么 响应状态应为 200
    而且 响应正文应为 hello
    而且 响应应携带自定义响应头 X-Test-Header: tx-cli
    当 用户请求 /missing.txt
    那么 响应状态应为 404
    而且 响应正文应为 Not Found
    当 用户按下 Ctrl+C
    那么 服务器应停止并以退出码 0 结束

  场景: 静默启动服务器并自动打开浏览器
    假如 当前目录存在 index.html
    而且 本机 8080 端口可用
    当 用户执行 tx-cli server --silent --open
    那么 服务器应在 localhost:8080 提供当前目录的静态文件
    而且 不应输出常规启动信息
    而且 应尝试自动打开 http://localhost:8080

  场景大纲: 拒绝无效的服务器端口或响应头
    当 用户执行 <命令行>
    那么 命令应以退出码 1 结束
    而且 错误输出应包含 <错误提示>
    而且 不应启动静态服务器

    例子:
      | 命令行                            | 错误提示                    |
      | tx-cli server --port 0            | 端口号无效                  |
      | tx-cli server --port 65536        | 端口号无效                  |
      | tx-cli server --port 1.5          | 端口号无效                  |
      | tx-cli server --port abc          | 端口号无效                  |
      | tx-cli server --header not-json   | 不是合法的JSON              |
      | tx-cli server --header "[]"       | 必须是一个JSON对象          |

  场景大纲: Git 重命名成功或在前置检查中失败
    假如 <初始状态>
    当 用户执行 <命令>
    那么 命令应以退出码 <退出码> 结束
    而且 <预期结果>

    例子:
      | 初始状态                                               | 命令                                                   | 退出码 | 预期结果                                                       |
      | Git 仓库已跟踪 src/user/user.ts 且目标名不存在         | tx-cli git-rename src/user/user.ts src/user/User.ts    | 0      | src/user/User.ts 应被 Git 跟踪且旧路径不再存在                 |
      | Git 仓库中不存在 old.ts                                | tx-cli git-rename old.ts new.ts                        | 1      | 应提示文件不存在且不发生重命名                                 |
      | Git 仓库已跟踪 old.ts 且 new.ts 已存在                 | tx-cli git-rename old.ts new.ts                        | 1      | 应提示目标文件已存在且两个原文件均保持不变                     |
      | Git 仓库中的 old.ts 未被跟踪且 new.ts 不存在           | tx-cli git-rename old.ts new.ts                        | 1      | 应提示文件未被 Git 跟踪且 old.ts 保持不变                      |
      | 当前目录不是 Git 仓库且 old.ts 存在                    | tx-cli git-rename old.ts new.ts                        | 1      | 应提示当前目录不是 Git 仓库且不发生重命名                      |

  场景: 确认后按规范提交 ONES 修复信息
    假如 当前 Git 仓库已有暂存的文件修改
    当 用户执行 commit-fix 并传入以下消息:
      """
      #532311 优化属性设置
      https://ones.example.com/task/532311
      """
    那么 待确认的提交信息应为 fix(#532311): 优化属性设置
    当 用户选择确认提交
    那么 应创建提交信息为 fix(#532311): 优化属性设置 的新提交
    而且 输出应提示提交成功

  场景大纲: 不满足提交条件或用户取消时不创建提交
    假如 <仓库状态>
    当 用户尝试执行 tx-cli commit-fix "测试"，并在出现确认时选择取消
    那么 命令应以退出码 <退出码> 结束
    而且 输出应包含 <提示>
    而且 不应创建新的提交

    例子:
      | 仓库状态                       | 退出码 | 提示                                     |
      | 当前目录不是 Git 仓库          | 1      | 当前目录不是一个git仓库                  |
      | 当前 Git 仓库的暂存区为空      | 1      | 暂存区为空                               |
      | 当前 Git 仓库已有暂存内容      | 0      | 已取消                                   |
