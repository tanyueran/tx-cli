# @tanyueran/cli

| 一个命令行工具，可以创建项目，添加模块，以及支持一些简单的工具操作命令

## 安装

| npm install -g @tanyueran/cli

## 用法

```text

tx-cli [command] [options]

Options:
  -V, --version                               output the version number
  -h, --help                                  display help for command

Commands:
  add [module-name]                           添加模块
  create [project-name]                       创建项目
  server [options]                            启动一个本地HTTP服务器
  git-rename <old-model-url> <new-model-url>  git重命名模块
  commit-fix <message...>                     根据ones信息改为 fix(#id): title 格式提交git commit
  help [command]                              display help for command
```

### 各命令说明

#### `add [module-name]`

添加模块。不传模块名称时，会以交互式提示输入。

```bash
tx-cli add user-profile
```

#### `create [project-name]`

创建项目。不传项目名称时，会以交互式提示输入。

```bash
tx-cli create my-app
```

#### `server [options]`

启动一个本地 HTTP 静态文件服务器。

| 选项 | 说明 | 默认值 |
|---|---|---|
| `-p, --port <number>` | 端口号 | `8080` |
| `-H, --host <host>` | 主机地址 | `localhost` |
| `-d, --directory <path>` | 服务的目录 | `.` |
| `-o, --open` | 启动后自动打开浏览器 | - |
| `-s, --silent` | 静默模式，不输出信息 | - |
| `--header <json>` | 自定义 HTTP 响应头 | `{}` |

```bash
tx-cli server -p 3000 -o
tx-cli server -d ./dist --header '{"Cache-Control":"no-cache"}'
```

#### `git-rename <old-model-url> <new-model-url>`

git 重命名模块名称，主要用于 git 跟踪的文件的名称大小写转换。通过两次 mv（先改中间名再改目标名）绕过大小写不敏感文件系统的限制。

```bash
# 将 user.ts 改为 User.ts
tx-cli git-rename src/user/user.ts src/user/User.ts
```

#### `commit-fix <message...>`

根据 ones 上的信息（`#id` + `title` + `message`）自动转换为 `fix(#id): title` 格式提交 git commit。注意消息需要用双引号包裹。

```bash
tx-cli commit-fix "#532311 优化属性设置 https://ones.x.cn/abc"
```

## TODO

- [x] 创建项目 `tx-cli create <project-name>`
- [x] 创建模块 `tx-cli add <module-name>`
- [x] server 命令（启用一个本地服务器）
- [x] git-rename 命令（git 重命名模块名称，支持大小写转换）
- [x] commit-fix 命令（格式化 ones 信息为 git commit）
- [ ] copy 命令（复制文件，支持过滤某些文件）`tx-cli copy <src> <dest> --filter <filter>`