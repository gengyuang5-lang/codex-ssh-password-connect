# Codex SSH Password Connect

[English README](README.md) · [产品演示视频](docs/demo.mp4) · [安全说明](SECURITY.md)

一个运行在本机的 Codex MCP 插件，通过 SSH 密码或本机私钥认证访问服务器项目。Codex 和插件都在本机运行，通过 SSH/SFTP 按需读写远程文件；默认不把整个仓库复制到本机，服务器不安装 Codex 或 VS Code Server。密码和私钥口令由本机窗口收集，不会成为 Codex 工具参数、对话内容或配置项。

## 安全行为

- 密码仅在本机 Windows 凭据对话框输入；私钥由本机文件选择器读取。密码、私钥内容和密钥口令不会写入配置或输出到 MCP 工具结果。
- 安装时缓存本机弹窗 helper 以减少启动等待；密码窗口会尽量显示在当前 Codex 窗口前方，单次等待 15 分钟；输错后自动重新询问，最多 5 次；关闭或超时后可选择重新打开。

- 首次连接时显示服务器 SSH 主机指纹，必须由用户确认后才会保存到 `%APPDATA%\CodexSSH\known-hosts.json`。
- 已信任主机的指纹变化时会拒绝连接。若管理员确认是合法的主机密钥轮换，先手动删除对应条目，再重新连接并核对新指纹。
- 远程命令和写文件都标记为有副作用的 MCP 工具，由 Codex 的工具批准提示统一确认；插件不再额外弹 Windows 操作确认框。
- 可通过 SFTP 浏览目录、分段读取大文本、流式修改大文本和分块上传大文本；不会把整个项目复制到本机。旧的单次读取/写入工具仍限制为 256 KiB，便于处理小文件。
- 大文件编辑通过服务器同目录临时文件完成；只有补丁匹配数、目标文件状态和 UTF-8/SHA-256 校验通过后才会替换原文件。所有远程写操作由 Codex 的工具批准提示控制。
- SSH 状态监控器自动读取 Codex 当前线程 ID，并从本机 Codex 标题库显示聊天标题；安装时还会根据本机 SSH 工具历史回填旧连接标题。标题只保存在本机，不会发送到服务器。
- 私钥必须留在本机，服务器应配置对应的公钥（`authorized_keys`）。如果曾把私钥复制到服务器，应从服务器移除并轮换该密钥。

## 安装

需要 Windows、Node.js 22.5 或更新版本（内置 SQLite 用于读取聊天标题），以及 Codex 桌面版/本地 Codex 客户端。

1. 下载[CodexSSHPasswordConnect-1.6.5-win-x64.zip](https://github.com/gengyuang5-lang/codex-ssh-password-connect/releases/download/v1.6.5/CodexSSHPasswordConnect-1.6.5-win-x64.zip)，解压到一个长期保留的本机目录；不要从临时下载目录运行。
2. 双击 `install.cmd`，或在 PowerShell 中运行 `install.ps1`。脚本会更新本机插件、回填旧连接标题、启用插件，并移除旧的重复 MCP 入口，避免一个聊天同时加载两套 SSH 工具。
3. 完全退出并重新打开 Codex 和 VS Code，使新版本加载。已经运行的旧 MCP 进程会继续使用旧代码，退出应用后才会结束。
4. SSH 成功连接后会自动启动或唤醒唯一的 `CodexSSHMonitor.exe` 窗口；也可手动打开它查看 MCP 进程、待连接状态和 SSH 连接状态。监控窗口不保存或显示密码。


如果你从源码重新打包且缺少 `node_modules`，先在插件目录运行 `npm ci --omit=dev`。如果 Codex 命令行不在 `PATH` 中，可打开 `install.ps1`，将 `$CodexCommand` 改为 `codex.exe` 的完整路径后再运行。脚本只写入本地 Codex 插件市场和插件配置，不接触 SSH 密码。

## 使用

告诉 Codex 服务器地址、SSH 用户名和端口。默认使用密码登录；需要私钥时，告诉 Codex 使用本机私钥。首次选择后，插件会记住私钥文件路径；后续私钥连接会直接使用它，不再弹文件选择框。服务器必须已配置对应公钥：

1. 密码模式：在 Windows 凭据窗口输入 SSH 密码。私钥模式：首次在本机选择私钥文件；若私钥加密，再在本机输入密钥口令。以后插件会自动使用记住的本机私钥路径。只有明确要更换密钥时，才调用独立的 `ssh_set_default_private_key` 工具重新选择。不要把密码、私钥或口令粘贴到聊天中。
2. 首次连接时核对管理员提供的主机指纹并确认。
3. Codex 可以通过 SFTP 工具浏览、读取和编辑远程项目文件，也可以运行服务器命令；命令和写文件统一由 Codex 的 MCP 工具批准提示确认。
4. 完成后 Codex 调用 `ssh_disconnect`。

## 大文件处理

为减少 token，文件预览和分段读取默认每次返回 8 KiB，命令输出默认每个流 8 KiB，目录列表默认 50 项。确实需要更多内容时，再提高 `maxBytes`、`maxOutputBytes` 或目录 `limit`；分段读取使用 `nextOffset` 继续。

256 KiB 是 `ssh_read_file` 和 `ssh_write_file` 这两个单次工具的载荷上限，不是远程文件的大小上限。处理更大的 UTF-8 代码或文本时，Codex 可按下面方式工作：

- `ssh_get_file_info` 查看文件大小和类型。
- `ssh_read_file_range` 每次最多读取 16 KiB（默认 8 KiB），按返回的 `nextOffset` 继续；读取内容留在工具结果里，不保存完整本地副本。
- `ssh_patch_file` 提供不超过 16 KiB 的原文和替换文本，由本机 MCP 通过 SFTP 流式处理整份远程文件，再在服务器同目录用临时文件原子替换。默认要求恰好匹配一次；文件在处理期间被改动或匹配数不符时会中止并保留原件。
- 创建较大的 UTF-8 文件时，使用 `ssh_upload_begin`、多次 `ssh_upload_chunk`、`ssh_upload_status` 和 `ssh_upload_commit`。可选填总字节数；每块最多 32 KiB，最终提交前会验证 UTF-8 和可选 SHA-256；`ssh_upload_abort` 可清理未完成的临时文件。每条 SSH 连接最多同时进行 4 个上传。

分段读取和补丁不会把整份文件放进模型上下文。新建大文件仍需由 Codex 分块提供内容，因此模型上下文和工具载荷仍有限制；上传期间还需要服务器为临时文件留出空间。以上工具只支持 UTF-8 文本，不是二进制 WinSCP 同步功能。若 SSH 会话意外断开，未完成的隐藏临时上传文件可能需要在服务器上清理；正常调用 `ssh_disconnect` 会自动清理。

不要把 SSH 密码、私钥或密钥口令粘贴到聊天中。同一聊天对相同主机、端口、账号和认证方式重复连接会复用现有连接；确实要另开连接时再使用 `forceNew`。

## 实时连接监控

SSH MCP 成功连接后会自动启动或唤醒 `CodexSSHMonitor.exe`。插件优先从 Codex MCP 请求元数据读取当前聊天标题；若客户端未传线程信息，会在连接记录写入本机历史后自动重试匹配。安装时也会回填已有 SSH 工具历史标题。其他 MCP 客户端没有 Codex 标题时可传 `chatLabel`。监控窗口显示聊天标题、活动主机、用户名、端口、连接状态、连接时间和最近操作，每 2 秒刷新。PowerShell 等程序自己运行的 `ssh.exe` 不会触发此窗口。

## 文件说明

- `plugin.json`、`mcp.json`：Codex 插件和本地 MCP 配置。
- `server/index.js`：SSH 客户端和 MCP 工具，包括范围读取、流式文本补丁和分块上传。
- `server/windows-prompts.ps1`：Windows 原生密码和首次主机指纹确认对话框。
- `CodexSSHMonitor.exe`：实时连接状态窗口。
- `monitor/CodexSSHMonitor.cs`、`monitor/build-monitor.ps1`：监控程序源码和构建脚本。
- `skills/ssh-remote/SKILL.md`：Codex 使用规则。
- `install.ps1`：注册本地 MCP 服务和个人插件市场。
- `DESIGN.md`：本机 Codex、SSH/SFTP 和 WinSCP 式同步的分阶段设计。
