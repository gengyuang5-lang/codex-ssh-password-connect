# Security Notes

## Credential handling

- SSH passwords are entered in a local Windows credential dialog. Optional key authentication reads a private key selected on this PC. Passwords, key contents, and passphrases are not put in tool arguments, Codex conversations, configuration files, or status snapshots.
- The password is held in the local MCP process memory for SSH authentication and is cleared from the JavaScript connection configuration after authentication.
- The plugin does not copy SSH private keys to the server and does not save passwords or key passphrases to Windows Credential Manager. The server should contain only the matching public key in `authorized_keys`; if a private key was copied there, remove it and rotate that key.
- For private-key authentication, the selected local key is read into MCP process memory. Encrypted-key passphrases are entered in a local masked dialog and are not saved.
- The selected private-key path is saved in `%APPDATA%\CodexSSH\private-key-default.json` so future key-auth connections do not need to ask again. This file contains only the local path, never key material or a passphrase.
- SSH traffic is protected by the SSH transport. On first connection, verify the displayed host-key fingerprint. The fingerprint is pinned in `%APPDATA%\CodexSSH\known-hosts.json`; a changed fingerprint is rejected.

## Local information

The plugin runs on Windows. It writes connection metadata under `%APPDATA%\CodexSSH`:

- `status\mcp-<pid>.json` contains host, SSH username, port, connection times, recent operation labels, and the Codex chat title shown in the monitor. It contains no password or project file contents.
- `chat-labels.json` maps locally hashed connection identifiers to titles backfilled from local Codex SSH tool history. It contains titles only; it is not uploaded to the server.
- `known-hosts.json` contains pinned SSH host fingerprints.

Codex chat titles may contain project or task names. These files stay on the local PC, but users who share the Windows account or copy the status folder can see them. Delete `%APPDATA%\CodexSSH\chat-labels.json` to clear the title backfill.

The title resolver reads the Codex local `state_*.sqlite` title table using MCP thread metadata. The legacy backfill reads local SSH connection tool-call records and matching thread titles. If a new connection arrives before its tool call is indexed, the plugin retries this local match shortly afterward. It does not send conversation messages, tool history, or titles to the remote host or a telemetry service.

## Remote operations

- The remote SSH account can run commands and access files with its own permissions. Use a least-privilege account; root access increases the impact of mistakes.
- `ssh_run`, file writes, patches, and upload operations are marked consequential and configured for Codex approval prompts.
- Repeated connect calls in the same MCP chat reuse a matching active SSH session. Use `forceNew` only when a separate session is intentionally needed.
- Large text patches and uploads use hidden temporary files in the destination directory, then atomically replace the target when validation succeeds. Interrupted transfers may leave a temporary file that should be removed from the server.
- The 256 KiB limit applies to one-call read/write tools. Range reads, streamed patches, and chunk uploads support large UTF-8 text. They are not a binary file-transfer or full WinSCP synchronization implementation.

## Reporting a vulnerability

Before the repository has a GitHub Security Advisories endpoint, do not post credentials, private keys, or production server details in a public issue. Share a minimal, sanitized reproduction with the project maintainer through a private channel. After publication, enable and use GitHub private vulnerability reporting.
