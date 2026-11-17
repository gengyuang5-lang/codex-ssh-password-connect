# Changelog

## 1.6.4

- Remove key reselection from the normal SSH connect arguments so the saved key cannot be bypassed by an accidental flag.
- Add a separate tool for explicitly changing the remembered local key path.
- Use the saved key automatically whenever the path is present and valid.

## 1.6.3

- Remember the selected private-key file path locally and use it automatically on future key-auth connections.
- Add an explicit option to choose a different private key and make it the new local default.
- Store only the local path; never save private-key contents or passphrases.

## 1.6.2

- Use the plugin as the single Codex SSH entry point and migrate away from the duplicate legacy MCP registration.
- Update the installer so repeated same-chat connections use the plugin's session reuse path.
- Fix a duplicate status-field entry and clarify that private keys stay on the PC.

## 1.6.1

- Added optional local private-key authentication; private-key files and passphrases remain on the PC.
- Reuse matching SSH sessions and coalesce concurrent connects to avoid repeated login dialogs in one chat.
- Added an authentication-method indicator to the monitor.

## 1.6.0

- Added optional local private-key authentication with a local file picker and passphrase prompt.
- Reuse matching active sessions and coalesce simultaneous connection attempts to prevent duplicate logins in one MCP chat.
- Clarified that private keys stay local; only the matching public key belongs on the server.

## 1.5.9

- Retry local SSH-history title matching after each new connection when Codex thread metadata is absent or the local history index has not caught up.
- Accept Codex thread ID metadata under the supported host key variants.

## 1.5.8

- Resolve Codex chat titles from all supported MCP thread metadata key forms.
- Retry local SSH-history title matching shortly after a connection when thread metadata is unavailable or not yet indexed.

## 1.5.7

- Resolve Codex chat titles from the thread ID in MCP request metadata and the local Codex title database.
- Backfill older SSH status entries by matching local SSH tool-call history to connection timestamps; keep the title mapping local.
- Show only active SSH connections and pending logins in the monitor, hiding idle MCP workers and stale disconnected sessions.
- Add one-time title backfill during installation.

## 1.5.6

- Added Codex thread-title lookup and initial local-history backfill support.
- Added range reads, streamed text patches, and staged large UTF-8 uploads.

## 1.5.5

- Added local chat-label overrides and chat-title monitor presentation.

## 1.5.4

- Expanded the monitor title column and resolved Codex chat labels where available.

## 1.5.3

- Added process-ID fallback labels for older MCP status snapshots.
- Added single-instance monitor activation.

## 1.5.2

- Added chat labels to SSH status snapshots and monitor rows.

## 1.5.1

- Added range reads, streamed text patches, and chunked uploads for large UTF-8 files.
