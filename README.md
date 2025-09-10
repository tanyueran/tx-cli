# @tanyueran/cli

| 一个命令行工具，可以创建项目，添加模块

## 安装
| npm install -g @tanyueran/cli


## 用法
```text

Options:
  -V, --version                     output the version number
  -m, --module-name <moduleName>    模块名称
  -p, --project-name <projectName>  项目名称
  -h, --help                        display help for command

Commands:
  create <project-name>             创建项目
  add <module-name>                 添加模块
  help [command]                    display help for command

```

## TODO
- [x] 创建项目
- [x] 创建模块
- [ ] server 命令（启用一个本地服务器）
- [ ] copy 命令（复制文件，支持过滤某些文件）tx-cli copy <src> <dest> --filter <filter>