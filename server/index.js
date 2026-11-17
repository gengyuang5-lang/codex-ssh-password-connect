import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { backfillLegacyChatTitles, resolveCodexThreadTitle, statusSessionKey, threadIdFromRequest } from './chat-titles.js';
import { Client } from 'ssh2';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptScript = path.join(__dirname, 'windows-prompts.ps1');
const sessions = new Map();
const pendingConnections = new Map();
const connectionAttempts = new Map();
const uploads = new Map();
const maxOutputBytes = 48 * 1024;
const defaultOutputBytes = 8 * 1024;
const maxCommandLength = 2500;
const maxFileBytes = 256 * 1024;
const defaultReadBytes = 8 * 1024;
const maxRangeBytes = 16 * 1024;
const defaultRangeBytes = 8 * 1024;
const defaultDirectoryEntries = 50;
const maxDirectoryEntries = 500;
const maxUploadChunkBytes = 32 * 1024;
const maxPatchTextBytes = 16 * 1024;
const commandTimeoutMs = 120_000;

function processLabel() {
  return `窗口-${process.pid.toString(36).toUpperCase().slice(-4).padStart(4, '0')}`;
}

function sanitizeChatLabel(value) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : '';
  return Array.from(cleaned).slice(0, 64).join('') || processLabel();
}

function launchStatusMonitor() {
  const candidates = [
    path.resolve(__dirname, '..', 'CodexSSHMonitor.exe'),
    path.join(os.homedir(), '.codex', 'plugins', 'codex-ssh-password', 'CodexSSHMonitor.exe'),
  ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) return;
  try {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => {});
    child.unref();
  } catch {
    // Monitoring is optional and must never turn a successful SSH connection into a failure.
  }
}

function scheduleLegacyTitleBackfill(connectionId) {
  for (const delayMs of [3000, 10000]) {
    const timer = setTimeout(() => {
      const session = sessions.get(connectionId);
      if (!session || session.chatLabelSource !== 'history pending') return;
      try {
        backfillLegacyChatTitles();
        const labels = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-labels.json'), 'utf8'));
        const recovered = labels[statusSessionKey(process.pid, session)];
        if (typeof recovered === 'string' && recovered.trim()) {
          session.chatLabel = sanitizeChatLabel(recovered);
          session.chatLabelSource = 'local history';
          publishStatus();
        }
      } catch {
        // Title recovery is best-effort and must not affect the SSH connection.
      }
    }, delayMs);
    timer.unref();
  }
}

if (process.platform !== 'win32') {
  throw new Error('SSH Password Connect currently requires Windows for its secure native credential and confirmation dialogs.');
}

const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CodexSSH');
const knownHostsPath = path.join(dataDir, 'known-hosts.json');
const privateKeyPreferencePath = path.join(dataDir, 'private-key-default.json');
const statusDir = path.join(dataDir, 'status');
const statusPath = path.join(statusDir, `mcp-${process.pid}.json`);
const processStartedAt = Date.now();

function publishStatus(processState = 'running') {
  try {
    fs.mkdirSync(statusDir, { recursive: true });
    const snapshot = {
      processId: process.pid,
      processLabel: processLabel(),
      processState,
      processStartedAt,
      updatedAt: Date.now(),
      sessions: [...sessions.values()].map((session) => ({
        statusId: session.statusId,
        chatLabel: session.chatLabel,
        chatLabelSource: session.chatLabelSource,
        authMethod: session.authMethod || 'password',
        host: session.host,
        username: session.username,
        port: session.port,
        state: session.state || 'connected',
        connectedAt: session.connectedAt,
        lastActivityAt: session.lastActivityAt,
        lastAction: session.lastAction || 'Connected',
      })),
      pendingConnections: [...pendingConnections.values()],
    };
    fs.writeFileSync(statusPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Status monitoring is best-effort and must not interrupt SSH work.
  }
}

function readKnownHosts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(knownHostsPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read SSH host-key store: ${error.message}`);
  }
}

function saveKnownHost(key, fingerprint) {
  fs.mkdirSync(dataDir, { recursive: true });
  const current = readKnownHosts();
  current[key] = fingerprint;
  const tempPath = `${knownHostsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, knownHostsPath);
}

function isUsablePrivateKeyFile(keyPath) {
  if (typeof keyPath !== 'string' || !keyPath.trim()) return false;
  try {
    const stats = fs.statSync(keyPath);
    return stats.isFile() && stats.size >= 1 && stats.size <= 1024 * 1024;
  } catch {
    return false;
  }
}

function readDefaultPrivateKeyPath() {
  try {
    const preferences = JSON.parse(fs.readFileSync(privateKeyPreferencePath, 'utf8'));
    if (typeof preferences.privateKeyPath !== 'string' || !preferences.privateKeyPath.trim()) return null;
    const keyPath = path.resolve(preferences.privateKeyPath);
    return isUsablePrivateKeyFile(keyPath) ? keyPath : null;
  } catch {
    return null;
  }
}

function saveDefaultPrivateKeyPath(keyPath) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tempPath = `${privateKeyPreferencePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ privateKeyPath: path.resolve(keyPath) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, privateKeyPreferencePath);
}

async function chooseAndSaveDefaultPrivateKey(host = '', username = '', port = 22) {
  const selection = await runPowerShell('ChoosePrivateKey', [
    '-HostName', host,
    '-Port', String(port),
    '-UserName', username,
  ], undefined, 900_000);
  if (selection.cancelled) throw new Error('Private-key selection cancelled.');
  if (!selection.path || typeof selection.path !== 'string') throw new Error('No local private-key file was selected.');
  const keyPath = path.resolve(selection.path);
  if (!isUsablePrivateKeyFile(keyPath)) {
    throw new Error('The selected local private-key file must be a non-empty file smaller than 1 MiB.');
  }
  saveDefaultPrivateKeyPath(keyPath);
  return keyPath;
}

function runPowerShell(mode, args = [], stdinJson = undefined, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', promptScript, '-Mode', mode, ...args,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Windows dialog timed out.'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not open Windows dialog: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Windows dialog helper exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('Windows dialog helper returned an invalid response.'));
      }
    });

    if (stdinJson === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(stdinJson));
  });
}

function validateHost(host) {
  if (typeof host !== 'string' || !host.trim() || host.length > 253 || /[\s\r\n]/.test(host)) {
    throw new Error('host must be a hostname or IP address without spaces.');
  }
  return host.trim();
}

function fingerprintFor(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function isAuthenticationFailure(error) {
  return /all configured authentication methods failed|authentication failed|unable to authenticate|permission denied/i.test(error?.message || '');
}

async function askToReopenCredentialDialog(host, username, port, promptMessage) {
  return runPowerShell('RetryCredential', [
    '-HostName', host, '-Port', String(port), '-UserName', username, '-PromptMessage', promptMessage,
  ], undefined, 180_000);
}

async function connectWithAuth(host, enteredUsername, port, auth) {
  const client = new Client();
  const knownHostId = `${host.toLowerCase()}:${port}`;
  let verificationError = null;
  let connected = false;

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSH connection timed out.')), 180_000);
      const fail = (error) => {
        clearTimeout(timeout);
        reject(verificationError || error);
      };

      client.once('ready', () => {
        connected = true;
        if (client.config) {
          client.config.password = undefined;
          client.config.privateKey = undefined;
          client.config.passphrase = undefined;
        }
        clearTimeout(timeout);
        resolve();
      });
      client.once('error', fail);
      client.once('close', () => {
        if (!connected) fail(new Error('SSH connection closed before authentication completed.'));
      });

      client.connect({
        host,
        port,
        username: enteredUsername,
        ...(auth.authMethod === 'privateKey'
          ? { privateKey: auth.privateKey, ...(auth.passphrase ? { passphrase: auth.passphrase } : {}) }
          : { password: auth.password }),
        readyTimeout: 150_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key, callback) => {
          (async () => {
            const fingerprint = fingerprintFor(key);
            const existing = readKnownHosts()[knownHostId];
            if (existing) {
              if (existing !== fingerprint) {
                verificationError = new Error(`SSH host-key mismatch for ${knownHostId}. Expected ${existing}; received ${fingerprint}. Connection refused.`);
                callback(false);
                return;
              }
              callback(true);
              return;
            }

            const result = await runPowerShell('ConfirmHost', [
              '-HostName', host, '-Port', String(port), '-Fingerprint', fingerprint,
            ]);
            if (!result.approved) {
              verificationError = new Error('Connection refused because the server host key was not approved.');
              callback(false);
              return;
            }
            saveKnownHost(knownHostId, fingerprint);
            callback(true);
          })().catch((error) => {
            verificationError = error;
            callback(false);
          });
        },
      });
    });

    return {
      client,
      username: enteredUsername,
      authMethod: auth.authMethod,
      keyFingerprint: auth.keyFingerprint,
      keyPath: auth.keyPath,
    };
  } catch (error) {
    client.end();
    throw error;
  } finally {
    if (client.config) {
      client.config.password = undefined;
      client.config.privateKey = undefined;
      client.config.passphrase = undefined;
    }
  }
}

async function connectWithPassword(host, username, port) {
  let attempt = 1;
  let promptMessage = '';
  const maxPasswordAttempts = 5;

  while (attempt <= maxPasswordAttempts) {
    let credentials;
    try {
      credentials = await runPowerShell('Credential', [
        '-HostName', host,
        '-Port', String(port),
        '-UserName', username,
        '-Attempt', String(attempt),
        '-PromptMessage', promptMessage,
      ], undefined, 900_000);
    } catch (error) {
      if (!/dialog timed out/i.test(error.message)) throw error;
      const retry = await askToReopenCredentialDialog(host, username, port, 'The password window timed out. Reopen it now?');
      if (retry.retry) continue;
      throw new Error('Connection cancelled after the password window timed out. Call ssh_connect to try again.');
    }

    if (credentials.cancelled) {
      const retry = await askToReopenCredentialDialog(host, username, port, 'The password window was closed. Reopen it now?');
      if (retry.retry) continue;
      throw new Error('Connection cancelled while entering credentials. Call ssh_connect to try again.');
    }
    if (!credentials.password || !credentials.username) {
      credentials.password = '';
      throw new Error('A username and password are required.');
    }

    try {
      return await connectWithAuth(host, credentials.username, port, { authMethod: 'password', password: credentials.password });
    } catch (error) {
      if (!isAuthenticationFailure(error)) throw error;
      if (attempt >= maxPasswordAttempts) {
        throw new Error(`SSH authentication failed after ${maxPasswordAttempts} password attempts.`);
      }
      attempt += 1;
      promptMessage = 'The SSH server rejected that password. Enter it again.';
    } finally {
      credentials.password = '';
    }
  }

  throw new Error('SSH connection could not be established. Call ssh_connect to try again.');
}

function isPrivateKeyPassphraseFailure(error) {
  return /encrypted.*private|passphrase.*(required|given|bad)|bad passphrase|integrity check failed/i.test(error?.message || '');
}

async function connectWithPrivateKey(host, username, port) {
  const keyPath = readDefaultPrivateKeyPath() || await chooseAndSaveDefaultPrivateKey(host, username, port);

  const keyStats = fs.statSync(keyPath);
  if (!keyStats.isFile() || keyStats.size < 1 || keyStats.size > 1024 * 1024) {
    throw new Error('The selected local private-key file must be a non-empty file smaller than 1 MiB.');
  }

  const privateKey = fs.readFileSync(keyPath);
  const keyFingerprint = crypto.createHash('sha256').update(privateKey).digest('hex');
  let passphrase;
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await connectWithAuth(host, username, port, {
          authMethod: 'privateKey', privateKey, passphrase, keyFingerprint, keyPath,
        });
      } catch (error) {
        if (!isPrivateKeyPassphraseFailure(error)) throw error;
        if (attempt === 5) throw new Error('The private-key passphrase was rejected five times.');
        const result = await runPowerShell('KeyPassphrase', [
          '-HostName', host,
          '-Port', String(port),
          '-UserName', username,
          '-Attempt', String(attempt),
          '-PromptMessage', attempt === 1 ? 'This local private key is encrypted.' : 'That passphrase was not accepted. Try again.',
        ], undefined, 900_000);
        if (result.cancelled) throw new Error('Private-key authentication cancelled while entering the passphrase.');
        passphrase = typeof result.passphrase === 'string' ? result.passphrase : '';
      }
    }
  } finally {
    privateKey.fill(0);
    passphrase = '';
  }
  throw new Error('Private-key authentication could not be established.');
}

function executeRemoteCommand(client, command, outputLimitBytes = maxOutputBytes) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;

      const collect = (target, currentSize, chunk) => {
        const bytes = Buffer.from(chunk);
        const room = Math.max(0, outputLimitBytes - currentSize);
        if (room > 0) target.push(bytes.subarray(0, room));
        if (bytes.length > room) truncated = true;
        return currentSize + Math.min(room, bytes.length);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        resolve({ code: null, signal: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), truncated, timedOut: true });
      }, commandTimeoutMs);

      stream.on('data', (chunk) => { stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk); });
      stream.stderr.on('data', (chunk) => { stderrBytes = collect(stderrChunks, stderrBytes, chunk); });
      stream.once('error', (streamError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(streamError);
      });
      stream.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), truncated, timedOut: false });
      });
    });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function withSftp(session, callback, action = 'SFTP operation') {
  const sftp = await openSftp(session.client);
  session.state = 'busy';
  session.lastAction = action;
  session.lastActivityAt = Date.now();
  publishStatus();
  try {
    return await callback(sftp);
  } finally {
    sftp.end();
    session.state = 'connected';
    session.lastAction = `${action} complete`;
    session.lastActivityAt = Date.now();
    publishStatus();
  }
}

function getSession(connectionId) {
  const session = sessions.get(connectionId);
  if (!session) throw new Error('No active connection exists for that ID. Connect again and use its new connection ID.');
  return session;
}

function findReusableSession(host, username, port, authMethod, threadId, keyPath) {
  for (const [connectionId, session] of sessions) {
    const sameThread = !threadId || !session.threadId || session.threadId === threadId;
    if (session.host.toLowerCase() === host.toLowerCase()
        && session.username === username
        && session.port === port
        && session.authMethod === authMethod
        && (authMethod !== 'privateKey' || session.keyPath === keyPath)
        && sameThread) {
      return { connectionId, session };
    }
  }
  return null;
}

function connectionAttemptKey(host, username, port, authMethod, threadId, keyPath) {
  return JSON.stringify([threadId || `process:${process.pid}`, host.toLowerCase(), username, port, authMethod, authMethod === 'privateKey' ? keyPath : null]);
}

async function establishSshSession({ host, username, port, authMethod, chatLabel, chatLabelSource, threadId }) {
  const pendingId = crypto.randomUUID();
  pendingConnections.set(pendingId, {
    pendingId,
    chatLabel,
    chatLabelSource,
    authMethod,
    host,
    username,
    port,
    state: 'Waiting for SSH authentication',
    startedAt: Date.now(),
  });
  publishStatus();

  let connected;
  try {
    connected = authMethod === 'privateKey'
      ? await connectWithPrivateKey(host, username, port)
      : await connectWithPassword(host, username, port);
  } finally {
    pendingConnections.delete(pendingId);
    publishStatus();
  }

  const { client, username: actualUsername } = connected;
  const connectionId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    client,
    statusId: crypto.randomUUID(),
    chatLabel,
    chatLabelSource,
    threadId,
    authMethod: connected.authMethod,
    keyFingerprint: connected.keyFingerprint || null,
    keyPath: connected.keyPath || null,
    host,
    username: actualUsername,
    port,
    state: 'connected',
    connectedAt: now,
    lastActivityAt: now,
    lastAction: 'Connected',
  };
  sessions.set(connectionId, session);
  client.once('close', () => {
    sessions.delete(connectionId);
    for (const [uploadId, upload] of uploads) {
      if (upload.connectionId === connectionId) uploads.delete(uploadId);
    }
    publishStatus();
  });
  publishStatus();
  launchStatusMonitor();
  if (chatLabelSource === 'history pending') scheduleLegacyTitleBackfill(connectionId);

  return {
    content: [{ type: 'text', text: `Connected to ${actualUsername}@${host}:${port} via ${connected.authMethod} (${chatLabel}). Connection ID: ${connectionId}` }],
    structuredContent: { connectionId, host, username: actualUsername, port, authMethod: connected.authMethod, chatLabel, reused: false },
  };
}

function validateRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || !remotePath.trim() || remotePath.length > 4096 || /[\0\r\n]/u.test(remotePath)) {
    throw new Error('path must be a non-empty remote path without NUL or line breaks.');
  }
  return remotePath;
}

function readUtf8Range(sftp, remotePath, offset, maxBytes, fileSize) {
  if (offset > fileSize) throw new Error(`Offset ${offset} is past end of file (${fileSize} bytes).`);
  if (offset === fileSize) return Promise.resolve({ startOffset: offset, nextOffset: offset, bytesRead: 0, eof: true, content: '' });

  return new Promise((resolve, reject) => {
    const end = Math.min(fileSize - 1, offset + maxBytes + 3);
    const chunks = [];
    const stream = sftp.createReadStream(remotePath, { start: offset, end });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => {
      const bytes = Buffer.concat(chunks);
      let start = 0;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
      if (start >= bytes.length) {
        reject(new Error('Could not find a UTF-8 character boundary in this file range.'));
        return;
      }

      let endIndex = Math.min(bytes.length, start + maxBytes);
      if (offset + endIndex < fileSize) {
        while (endIndex > start && endIndex < bytes.length && (bytes[endIndex] & 0xc0) === 0x80) endIndex -= 1;
      }
      if (endIndex === start && offset + start < fileSize) {
        reject(new Error('The requested byte limit is too small for the next UTF-8 character. Request at least 4 bytes.'));
        return;
      }
      const selected = bytes.subarray(start, endIndex);
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(selected);
        const startOffset = offset + start;
        const nextOffset = startOffset + selected.length;
        resolve({ startOffset, nextOffset, bytesRead: selected.length, eof: nextOffset >= fileSize, content });
      } catch {
        reject(new Error('File is not valid UTF-8 text; use a remote command to inspect binary files.'));
      }
    });
  });
}

function isRegularFile(attrs) {
  return ((attrs.mode ?? 0) & 0o170000) === 0o100000;
}

function siblingTempPath(remotePath, purpose) {
  const directory = path.posix.dirname(remotePath);
  const baseName = path.posix.basename(remotePath);
  if (!baseName || baseName === '.' || baseName === '/') throw new Error('A regular file path is required.');
  const tempName = `.codex-${purpose}-${crypto.randomUUID()}.tmp`;
  return directory === '.' ? tempName : path.posix.join(directory, tempName);
}

async function atomicReplace(sftp, tempPath, remotePath, targetExists) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await sftpCall(sftp, 'ext_openssh_rename', tempPath, remotePath);
      return;
    } catch (error) {
      if (targetExists) {
        throw new Error(`The server could not atomically replace the existing file: ${error.message}`);
      }
    }
  } else if (targetExists) {
    throw new Error('This SFTP server does not support atomic replacement of an existing file. The original was left untouched.');
  }
  await sftpCall(sftp, 'rename', tempPath, remotePath);
}

function createStreamingTextPatchTransform(oldBytes, newBytes, expectedOccurrences) {
  let carry = Buffer.alloc(0);
  let occurrences = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  return {
    occurrences: () => occurrences,
    transform: new Transform({
      transform(chunk, _encoding, callback) {
        try {
          decoder.decode(chunk, { stream: true });
          const data = carry.length ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
          const safeStarts = Math.max(0, data.length - oldBytes.length + 1);
          const output = [];
          let cursor = 0;
          let searchFrom = 0;
          while (searchFrom < safeStarts) {
            const found = data.indexOf(oldBytes, searchFrom);
            if (found < 0 || found >= safeStarts) break;
            output.push(data.subarray(cursor, found), newBytes);
            cursor = found + oldBytes.length;
            searchFrom = cursor;
            occurrences += 1;
          }
          const emitEnd = Math.max(safeStarts, cursor);
          output.push(data.subarray(cursor, emitEnd));
          carry = data.subarray(emitEnd);
          callback(null, Buffer.concat(output));
        } catch (error) {
          callback(new Error(`File is not valid UTF-8 text: ${error.message}`));
        }
      },
      flush(callback) {
        try {
          decoder.decode();
          const output = [];
          let cursor = 0;
          while (cursor <= carry.length - oldBytes.length) {
            const found = carry.indexOf(oldBytes, cursor);
            if (found < 0) break;
            output.push(carry.subarray(cursor, found), newBytes);
            cursor = found + oldBytes.length;
            occurrences += 1;
          }
          output.push(carry.subarray(cursor));
          carry = Buffer.alloc(0);
          if (occurrences !== expectedOccurrences) {
            callback(new Error(`Patch expected ${expectedOccurrences} occurrence(s), but found ${occurrences}. Original file was left untouched.`));
            return;
          }
          callback(null, Buffer.concat(output));
        } catch (error) {
          callback(new Error(`File is not valid UTF-8 text: ${error.message}`));
        }
      },
    }),
  };
}

function writeSftpAt(sftp, remotePath, offset, data) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'r+', (openError, handle) => {
      if (openError) {
        reject(openError);
        return;
      }
      sftp.write(handle, data, 0, data.length, offset, (writeError, bytesWritten) => {
        sftp.close(handle, (closeError) => {
          if (writeError) reject(writeError);
          else if (closeError) reject(closeError);
          else resolve();
        });
      });
    });
  });
}

function remoteNotFound(error) {
  return error?.code === 2 || error?.code === 'ENOENT' || /no such file or directory/i.test(error?.message || '');
}

async function getOptionalRemoteAttrs(sftp, remotePath) {
  try {
    return await sftpCall(sftp, 'lstat', remotePath);
  } catch (error) {
    if (remoteNotFound(error)) return null;
    throw error;
  }
}

function fileSignature(attrs) {
  return attrs ? { size: attrs.size, mtime: attrs.mtime, mode: attrs.mode & 0o777, uid: attrs.uid, gid: attrs.gid } : null;
}

async function preserveOwnership(sftp, tempPath, attrs) {
  if (Number.isInteger(attrs.uid) && attrs.uid >= 0 && Number.isInteger(attrs.gid) && attrs.gid >= 0) {
    await sftpCall(sftp, 'chown', tempPath, attrs.uid, attrs.gid);
  }
}

async function hashAndValidateUtf8(sftp, remotePath) {
  const hash = crypto.createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = sftp.createReadStream(remotePath);
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return hash.digest('hex');
  } catch (error) {
    stream.destroy();
    throw new Error(`Upload is not a complete UTF-8 text file: ${error.message}`);
  }
}

const server = new McpServer({
  name: 'codex-ssh-password',
  version: '1.6.5',
  instructions: 'Runs locally on Windows. For key auth, use the saved local key; call ssh_set_default_private_key only on explicit key changes. Never request credentials in chat. Confirm the host fingerprint. Reads default to small outputs; use offsets or raise limits only when needed. Remote commands and writes require Codex approval. Reuse matching chat sessions; forceNew is for intentional separate sessions.',
});

server.registerTool('ssh_connect', {
  title: 'Connect to an SSH server',
  description: 'Connect by local password or saved private key. Verify the first-use host fingerprint. Matching calls in one chat reuse the session; use forceNew only for a separate session.',
  inputSchema: {
    host: z.string().min(1).max(253).describe('Server hostname or IP.'),
    username: z.string().min(1).max(256).describe('SSH account.'),
    port: z.number().int().min(1).max(65535).default(22).describe('SSH port.'),
    authMethod: z.enum(['password', 'privateKey']).default('password').describe('Password prompt or saved local private key; server needs its matching public key.'),
    forceNew: z.boolean().default(false).describe('Open a separate session instead of reusing one.'),
    chatLabel: z.string().max(128).optional().describe('Optional concise chat title for the monitor.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ host: rawHost, username, port, authMethod, forceNew, chatLabel: rawChatLabel }, extra) => {
  const host = validateHost(rawHost);
  const requestedUsername = username.trim();
  if (!requestedUsername || /[\r\n]/.test(requestedUsername)) throw new Error('username must not be empty or contain line breaks.');
  const threadId = threadIdFromRequest(extra);
  const codexTitle = resolveCodexThreadTitle(threadId);
  const chatLabel = sanitizeChatLabel(codexTitle || rawChatLabel);
  const chatLabelSource = codexTitle ? 'Codex thread metadata' : rawChatLabel ? 'chatLabel argument' : 'history pending';
  const forceSeparateConnection = forceNew;
  const defaultKeyPath = authMethod === 'privateKey' ? readDefaultPrivateKeyPath() : null;

  if (!forceSeparateConnection) {
    const reusable = findReusableSession(host, requestedUsername, port, authMethod, threadId, defaultKeyPath);
    if (reusable) {
      if (codexTitle || rawChatLabel) {
        reusable.session.chatLabel = chatLabel;
        reusable.session.chatLabelSource = chatLabelSource;
      }
      reusable.session.lastAction = 'Reused existing SSH connection';
      reusable.session.lastActivityAt = Date.now();
      publishStatus();
      return {
        content: [{ type: 'text', text: `Reused existing ${authMethod} connection to ${requestedUsername}@${host}:${port} (${reusable.session.chatLabel}). Connection ID: ${reusable.connectionId}` }],
        structuredContent: { connectionId: reusable.connectionId, host, username: requestedUsername, port, authMethod, chatLabel: reusable.session.chatLabel, reused: true },
      };
    }
  }

  const key = connectionAttemptKey(host, requestedUsername, port, authMethod, threadId, defaultKeyPath);
  const inFlight = !forceSeparateConnection ? connectionAttempts.get(key) : null;
  if (inFlight) return inFlight;

  const attempt = establishSshSession({ host, username: requestedUsername, port, authMethod, chatLabel, chatLabelSource, threadId });
  if (forceSeparateConnection) return attempt;
  connectionAttempts.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (connectionAttempts.get(key) === attempt) connectionAttempts.delete(key);
  }
});

server.registerTool('ssh_set_default_private_key', {
  title: 'Set the default local SSH private key',
  description: 'Choose or change the local default private-key path. Use only on explicit request; key contents and passphrase are not saved.',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  const keyPath = await chooseAndSaveDefaultPrivateKey();
  return {
    content: [{ type: 'text', text: 'Saved the selected local private-key file as the default for future private-key SSH connections. Only its path was saved; the key contents and passphrase were not stored.' }],
    structuredContent: { saved: true, fileExists: isUsablePrivateKeyFile(keyPath) },
  };
});

server.registerTool('ssh_run', {
  title: 'Run an SSH command',
  description: 'Run a remote shell command; output defaults to 8 KiB per stream.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    command: z.string().min(1).max(maxCommandLength).describe('Remote command.'),
    maxOutputBytes: z.number().int().min(1024).max(maxOutputBytes).default(defaultOutputBytes).describe('Bytes per output stream; default 8 KiB, max 48 KiB.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, command, maxOutputBytes: outputLimitBytes }) => {
  const session = sessions.get(connectionId);
  if (!session) throw new Error('No active connection exists for that ID. Connect again and use its new connection ID.');
  if (!command.trim()) throw new Error('command must not be empty.');

  session.state = 'busy';
  session.lastAction = 'Running remote command';
  session.lastActivityAt = Date.now();
  publishStatus();
  let result;
  try {
    result = await executeRemoteCommand(session.client, command, outputLimitBytes);
  } finally {
    if (sessions.get(connectionId) === session) {
      session.state = 'connected';
      session.lastAction = 'Command complete';
      session.lastActivityAt = Date.now();
      publishStatus();
    }
  }
  const parts = [
    result.timedOut ? 'Timed out after 120 seconds.' : `Exit code: ${result.code ?? 'unknown'}${result.signal ? ` (signal ${result.signal})` : ''}`,
  ];
  if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
  if (result.truncated) parts.push(`Output was truncated at ${outputLimitBytes / 1024} KiB per stream.`);
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
});

server.registerTool('ssh_list_directory', {
  title: 'List a remote project directory',
  description: 'List one compact directory page; use nextOffset to continue.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote directory path.'),
    offset: z.number().int().min(0).default(0).describe('Starting entry index.'),
    limit: z.number().int().min(1).max(maxDirectoryEntries).default(defaultDirectoryEntries).describe('Page size; default 50, max 500.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ connectionId, path: rawPath, offset, limit }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const entries = await withSftp(session, (sftp) => sftpCall(sftp, 'readdir', remotePath), 'List directory');
  const page = entries.slice(offset, offset + limit);
  const items = page.map((entry) => {
    const mode = (entry.attrs.mode ?? 0) & 0o170000;
    const type = mode === 0o040000 ? 'directory' : mode === 0o120000 ? 'symlink' : 'file';
    return {
      name: entry.filename,
      type,
      size: entry.attrs.size,
      modified: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null,
    };
  });
  const nextOffset = offset + items.length < entries.length ? offset + items.length : null;
  return { content: [{ type: 'text', text: JSON.stringify({ path: remotePath, entries: items, nextOffset }, null, 2) }] };
});

server.registerTool('ssh_read_file', {
  title: 'Read a remote project file',
  description: 'Read a UTF-8 preview; defaults to 8 KiB. Use ranges for the rest.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote path.'),
    maxBytes: z.number().int().min(1).max(maxFileBytes).default(defaultReadBytes).describe('Bytes to return; default 8 KiB, max 256 KiB.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ connectionId, path: rawPath, maxBytes }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const result = await withSftp(session, async (sftp) => {
    const attrs = await sftpCall(sftp, 'stat', remotePath);
    if (!isRegularFile(attrs)) throw new Error('Only regular UTF-8 text files can be read.');
    return { size: attrs.size, ...await readUtf8Range(sftp, remotePath, 0, maxBytes, attrs.size) };
  }, 'Read file');
  const { content, ...meta } = result;
  return { content: [{ type: 'text', text: `${JSON.stringify({ path: remotePath, ...meta })}\n${content}` }] };
});

server.registerTool('ssh_get_file_info', {
  title: 'Get remote file information',
  description: 'Get remote file type, size and modification time without reading content.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote path.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ connectionId, path: rawPath }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const attrs = await withSftp(session, (sftp) => sftpCall(sftp, 'lstat', remotePath), 'Get file information');
  const mode = attrs.mode ?? 0;
  const kind = (mode & 0o170000) === 0o040000 ? 'directory'
    : (mode & 0o170000) === 0o120000 ? 'symlink'
      : (mode & 0o170000) === 0o100000 ? 'file' : 'other';
  return { content: [{ type: 'text', text: JSON.stringify({ path: remotePath, type: kind, size: attrs.size, mode: mode & 0o7777, modified: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null }, null, 2) }] };
});

server.registerTool('ssh_read_file_range', {
  title: 'Read a range from a remote text file',
  description: 'Read a small UTF-8 range; continue with nextOffset.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote path.'),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).describe('Byte offset.'),
    maxBytes: z.number().int().min(1).max(maxRangeBytes).default(defaultRangeBytes).describe('Bytes to return; default 8 KiB, max 16 KiB.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ connectionId, path: rawPath, offset, maxBytes }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const result = await withSftp(session, async (sftp) => {
    const attrs = await sftpCall(sftp, 'stat', remotePath);
    if (!isRegularFile(attrs)) throw new Error('Only regular UTF-8 text files can be read by range.');
    const range = await readUtf8Range(sftp, remotePath, offset, maxBytes, attrs.size);
    return { path: remotePath, size: attrs.size, ...range };
  }, 'Read file range');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.registerTool('ssh_patch_file', {
  title: 'Apply a text patch to a remote file',
  description: 'Patch an exact UTF-8 fragment in place; streams the file and atomically replaces it after validation.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote path.'),
    oldText: z.string().min(1).max(maxPatchTextBytes).describe('Exact text to replace; max 16 KiB.'),
    newText: z.string().max(maxPatchTextBytes).describe('Replacement text; max 16 KiB.'),
    expectedOccurrences: z.number().int().min(1).max(1000000).default(1).describe('Required exact match count.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, path: rawPath, oldText, newText, expectedOccurrences }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const oldBytes = Buffer.from(oldText, 'utf8');
  const newBytes = Buffer.from(newText, 'utf8');
  if (oldBytes.length > maxPatchTextBytes || newBytes.length > maxPatchTextBytes) {
    throw new Error('Each patch fragment must be at most 16 KiB after UTF-8 encoding.');
  }
  if (oldBytes.equals(newBytes)) throw new Error('The old and new text are identical; no patch is needed.');

  const result = await withSftp(session, async (sftp) => {
    const originalAttrs = await sftpCall(sftp, 'lstat', remotePath);
    if (!isRegularFile(originalAttrs)) throw new Error('Only regular files can be patched. Symlinks and directories are refused.');
    const tempPath = siblingTempPath(remotePath, 'patch');
    const patch = createStreamingTextPatchTransform(oldBytes, newBytes, expectedOccurrences);
    try {
      await pipeline(
        sftp.createReadStream(remotePath),
        patch.transform,
        sftp.createWriteStream(tempPath, { flags: 'w', mode: originalAttrs.mode & 0o777 }),
      );
      const currentAttrs = await sftpCall(sftp, 'lstat', remotePath);
      if (currentAttrs.size !== originalAttrs.size || currentAttrs.mtime !== originalAttrs.mtime) {
        throw new Error('The source file changed while the patch was being prepared. Original file was left untouched; read it again and retry.');
      }
      await sftpCall(sftp, 'chmod', tempPath, originalAttrs.mode & 0o777);
      await preserveOwnership(sftp, tempPath, originalAttrs);
      await atomicReplace(sftp, tempPath, remotePath, true);
      return { occurrences: patch.occurrences(), path: remotePath, oldBytes: originalAttrs.size, mode: originalAttrs.mode & 0o777 };
    } catch (error) {
      try { await sftpCall(sftp, 'unlink', tempPath); } catch { /* temporary file may not exist */ }
      throw error;
    }
  }, 'Patch file');
  return { content: [{ type: 'text', text: `Applied ${result.occurrences} exact replacement(s) in ${result.path} using a temporary file. Original size: ${result.oldBytes} bytes.` }] };
});

server.registerTool('ssh_write_file', {
  title: 'Write a remote project file',
  description: 'Create or replace a UTF-8 text file up to 256 KiB.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote path.'),
    content: z.string().max(maxFileBytes).describe('UTF-8 content; max 256 KiB.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, path: rawPath, content }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const data = Buffer.from(content, 'utf8');
  if (data.length > maxFileBytes) throw new Error(`Content exceeds the ${maxFileBytes}-byte write limit.`);
  const hash = crypto.createHash('sha256').update(data).digest('hex');

  await withSftp(session, (sftp) => sftpCall(sftp, 'writeFile', remotePath, data), 'Write file');
  return { content: [{ type: 'text', text: `Wrote ${data.length} bytes to ${remotePath} (SHA-256 ${hash}).` }] };
});

server.registerTool('ssh_upload_begin', {
  title: 'Begin a large remote text-file upload',
  description: 'Stage a large UTF-8 upload; the destination is unchanged until commit.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    path: z.string().min(1).max(4096).describe('Remote destination path.'),
    totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Optional total bytes.'),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/iu).optional().describe('Optional SHA-256.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, path: rawPath, totalBytes, expectedSha256 }) => {
  const session = getSession(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const activeUploadCount = [...uploads.values()].filter((upload) => upload.connectionId === connectionId).length;
  if (activeUploadCount >= 4) throw new Error('At most four large-file uploads may be active on one SSH connection. Commit or abort an existing upload first.');
  const uploadId = crypto.randomUUID();
  const tempPath = siblingTempPath(remotePath, 'upload');
  const targetAttrs = await withSftp(session, async (sftp) => {
    const existing = await getOptionalRemoteAttrs(sftp, remotePath);
    if (existing && !isRegularFile(existing)) throw new Error('Only regular files can be replaced. Symlinks and directories are refused.');
    await sftpCall(sftp, 'writeFile', tempPath, Buffer.alloc(0), { mode: existing ? (existing.mode & 0o777) : 0o600 });
    return existing;
  }, 'Begin file upload');
  uploads.set(uploadId, {
    connectionId,
    path: remotePath,
    tempPath,
    totalBytes: totalBytes ?? null,
    nextOffset: 0,
    expectedSha256: expectedSha256?.toLowerCase() || null,
    targetSignature: fileSignature(targetAttrs),
    targetExists: Boolean(targetAttrs),
  });
  return { content: [{ type: 'text', text: JSON.stringify({ uploadId, path: remotePath, totalBytes: totalBytes ?? null, nextOffset: 0, maxChunkBytes: maxUploadChunkBytes, commitRequired: true }, null, 2) }] };
});

server.registerTool('ssh_upload_chunk', {
  title: 'Write a chunk to a large remote text-file upload',
  description: 'Write one UTF-8 upload chunk at the exact nextOffset.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    uploadId: z.string().uuid().describe('Upload ID.'),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Next byte offset.'),
    content: z.string().min(1).max(8192).describe('UTF-8 chunk; max 32 KiB encoded.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, uploadId, offset, content }) => {
  const session = getSession(connectionId);
  const upload = uploads.get(uploadId);
  if (!upload || upload.connectionId !== connectionId) throw new Error('No active upload exists for that ID. Begin a new upload.');
  if (upload.busy) throw new Error('Another operation is already using this upload. Check its status and retry.');
  if (offset !== upload.nextOffset) throw new Error(`Expected offset ${upload.nextOffset}; the destination file has not been changed.`);
  const data = Buffer.from(content, 'utf8');
  if (!data.length || data.length > maxUploadChunkBytes) throw new Error('Chunk must contain between 1 byte and 32 KiB of UTF-8 text.');
  if (upload.totalBytes !== null && offset + data.length > upload.totalBytes) throw new Error(`This chunk exceeds the declared upload size of ${upload.totalBytes} bytes.`);
  upload.busy = true;
  try {
    await withSftp(session, (sftp) => writeSftpAt(sftp, upload.tempPath, offset, data), 'Upload file chunk');
    upload.nextOffset += data.length;
    upload.lastActivityAt = Date.now();
  } finally {
    upload.busy = false;
  }
  return { content: [{ type: 'text', text: JSON.stringify({ uploadId, bytesWritten: data.length, nextOffset: upload.nextOffset, totalBytes: upload.totalBytes, complete: upload.totalBytes !== null && upload.nextOffset === upload.totalBytes }, null, 2) }] };
});

server.registerTool('ssh_upload_status', {
  title: 'Get large-file upload progress',
  description: 'Check an unfinished upload offset and remaining byte count.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    uploadId: z.string().uuid().describe('Upload ID.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ connectionId, uploadId }) => {
  const upload = uploads.get(uploadId);
  if (!upload || upload.connectionId !== connectionId) throw new Error('No active upload exists for that ID.');
  getSession(connectionId);
  return { content: [{ type: 'text', text: JSON.stringify({ uploadId, path: upload.path, totalBytes: upload.totalBytes, nextOffset: upload.nextOffset, remainingBytes: upload.totalBytes === null ? null : upload.totalBytes - upload.nextOffset }, null, 2) }] };
});

server.registerTool('ssh_upload_commit', {
  title: 'Commit a large remote text-file upload',
  description: 'Validate and atomically replace the destination with the staged upload.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    uploadId: z.string().uuid().describe('Upload ID.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, uploadId }) => {
  const session = getSession(connectionId);
  const upload = uploads.get(uploadId);
  if (!upload || upload.connectionId !== connectionId) throw new Error('No active upload exists for that ID. Begin a new upload.');
  if (upload.busy) throw new Error('Another operation is already using this upload. Check its status and retry.');
  if (upload.totalBytes !== null && upload.nextOffset !== upload.totalBytes) throw new Error(`Upload has ${upload.nextOffset} of ${upload.totalBytes} bytes. Continue sending chunks before commit.`);

  upload.busy = true;
  try {
    const result = await withSftp(session, async (sftp) => {
      const stagedAttrs = await sftpCall(sftp, 'stat', upload.tempPath);
      if (upload.totalBytes !== null && stagedAttrs.size !== upload.totalBytes) throw new Error(`Staged file has ${stagedAttrs.size} bytes; expected ${upload.totalBytes}.`);
      const actualSha256 = await hashAndValidateUtf8(sftp, upload.tempPath);
      if (upload.expectedSha256 && actualSha256 !== upload.expectedSha256) {
        throw new Error(`SHA-256 mismatch. Expected ${upload.expectedSha256}; got ${actualSha256}.`);
      }

      const currentTarget = await getOptionalRemoteAttrs(sftp, upload.path);
      if (upload.targetExists) {
        if (!currentTarget || !isRegularFile(currentTarget) || JSON.stringify(fileSignature(currentTarget)) !== JSON.stringify(upload.targetSignature)) {
          throw new Error('Destination changed while the upload was in progress. The existing file was left untouched.');
        }
        await sftpCall(sftp, 'chmod', upload.tempPath, upload.targetSignature.mode);
        await preserveOwnership(sftp, upload.tempPath, currentTarget);
      } else if (currentTarget) {
        throw new Error('A destination file appeared while the upload was in progress. It was left untouched.');
      }

      await atomicReplace(sftp, upload.tempPath, upload.path, upload.targetExists);
      return { path: upload.path, bytes: stagedAttrs.size, sha256: actualSha256 };
    }, 'Commit file upload');
    uploads.delete(uploadId);
    return { content: [{ type: 'text', text: `Committed ${result.bytes} bytes to ${result.path} (SHA-256 ${result.sha256}).` }] };
  } catch (error) {
    uploads.delete(uploadId);
    try {
      await withSftp(session, (sftp) => sftpCall(sftp, 'unlink', upload.tempPath), 'Clean up failed upload');
    } catch { /* the connection may have closed; the staged file is not the destination */ }
    throw error;
  }
});

server.registerTool('ssh_upload_abort', {
  title: 'Abort a large remote text-file upload',
  description: 'Discard an unfinished upload; destination stays unchanged.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
    uploadId: z.string().uuid().describe('Upload ID.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ connectionId, uploadId }) => {
  const session = getSession(connectionId);
  const upload = uploads.get(uploadId);
  if (!upload || upload.connectionId !== connectionId) return { content: [{ type: 'text', text: 'That upload is already closed.' }] };
  if (upload.busy) throw new Error('Another operation is already using this upload. Wait for it to finish before aborting.');
  upload.busy = true;
  try {
    await withSftp(session, (sftp) => sftpCall(sftp, 'unlink', upload.tempPath), 'Abort file upload');
  } finally {
    uploads.delete(uploadId);
  }
  return { content: [{ type: 'text', text: `Aborted upload for ${upload.path}; destination was not changed.` }] };
});

server.registerTool('ssh_disconnect', {
  title: 'Disconnect from an SSH server',
  description: 'Close an SSH connection.',
  inputSchema: {
    connectionId: z.string().uuid().describe('Active connection ID.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ connectionId }) => {
  const session = sessions.get(connectionId);
  if (!session) return { content: [{ type: 'text', text: 'That SSH connection is already closed.' }] };
  const activeUploads = [...uploads.entries()].filter(([, upload]) => upload.connectionId === connectionId);
  if (activeUploads.length) {
    try {
      await withSftp(session, async (sftp) => {
        for (const [, upload] of activeUploads) {
          try { await sftpCall(sftp, 'unlink', upload.tempPath); } catch { /* temporary file may already be missing */ }
        }
      }, 'Clean up unfinished uploads');
    } catch { /* the SSH link may already be unavailable */ }
    for (const [uploadId] of activeUploads) uploads.delete(uploadId);
  }
  sessions.delete(connectionId);
  publishStatus();
  session.client.end();
  return { content: [{ type: 'text', text: `Disconnected from ${session.username}@${session.host}:${session.port}.` }] };
});

const transport = new StdioServerTransport();
publishStatus();
const statusHeartbeat = setInterval(() => publishStatus(), 3000);
statusHeartbeat.unref();
await server.connect(transport);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(statusHeartbeat);
    publishStatus('stopping');
    for (const session of sessions.values()) session.client.end();
    sessions.clear();
    pendingConnections.clear();
    process.exit(0);
  });
}

process.on('exit', () => {
  try { fs.unlinkSync(statusPath); } catch { /* status file may already be gone */ }
});
