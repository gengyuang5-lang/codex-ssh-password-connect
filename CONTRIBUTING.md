# Contributing

Issues and pull requests are welcome. Please include a clear reproduction and redact hostnames, usernames, chat titles, local paths, and command output that could identify a private server or project.

## Development setup

Requirements: Windows, Node.js 22.5+, .NET Framework C# compiler components available through Windows PowerShell `Add-Type`, and FFmpeg/Pillow only for rebuilding the optional demo video.

```powershell
npm ci --omit=dev
node --check .\server\index.js
.\monitor\build-monitor.ps1
```

The MCP server uses stdio. Do not start it in a terminal and expect an interactive prompt; the password dialog appears only when Codex calls `ssh_connect`.

## Security changes

Do not add password arguments, credential persistence, disabled host-key checks, or remote file writes that bypass the MCP approval flow. Keep status and chat-title data local. Add tests or manual verification notes for changes to SSH/SFTP safety behavior.

## Release package

Run `tools/package-release.ps1` to validate the manifests, build the monitor, generate the demo, and create a versioned ZIP and SHA-256 file.
