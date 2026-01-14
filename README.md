# @tanyueran/cli

| 一个命令行工具，可以创建项目，添加模块，以及支持一些简单的工具操作命令

## 安装

| npm install -g @tanyueran/cli

## 用法

```text

tx-cli [command] [options]

Options:
  -V, --version                    output the version number
  -h, --help                       display help for command

Commands:
  add [options] <module-name>      添加模块
  create [options] <project-name>  创建项目
  server [options]                 启动一个本地HTTP服务器
  git-rename <old-name> <new-name>  git重命名模块名称(主要用于git跟踪的文件的名称大小写的转换)
  help [command]                   display help for command
```

## TODO

- [x] 创建项目 tx create <project-name>
- [x] 创建模块 tx add <module-name>
- [x] server 命令（启用一个本地服务器） tx server
- [x] git-rename 命令（git 重命名模块名称） tx-cli git-rename <old-name> <new-name>
- [ ] copy 命令（复制文件，支持过滤某些文件）tx-cli copy <src> <dest> --filter <filter>
