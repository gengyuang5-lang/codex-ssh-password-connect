import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // Node versions without the built-in SQLite module can still use chatLabel fallback values.
}

const titleCache = new Map();

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function latestDatabase(home, prefix) {
  try {
    const candidates = fs.readdirSync(home)
      .map((name) => ({ name, match: name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`, 'u')) }))
      .filter((item) => item.match)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
    for (const item of candidates) {
      const candidate = path.join(home, item.name);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Fall back to an empty title when Codex storage is unavailable.
  }
  return null;
}

function preferredTitle(row) {
  for (const value of [row?.name, row?.title, row?.preview]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function threadIdFromRequest(extra) {
  const sources = [extra?._meta, extra?.meta, extra?.request?._meta, extra?.request?.params?._meta];
  const keys = ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id'];
  for (const metadata of sources) {
    if (!metadata || typeof metadata !== 'object') continue;
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const thread = metadata.thread;
    if (thread && typeof thread === 'object') {
      for (const key of ['threadId', 'thread_id', 'id']) {
        const value = thread[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
  }
  return '';
}

export function resolveCodexThreadTitle(threadId) {
  if (!threadId) return '';
  if (titleCache.has(threadId)) return titleCache.get(threadId);
  if (!DatabaseSync) return '';

  const dbPath = latestDatabase(codexHome(), 'state');
  if (!dbPath) return '';

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT name, title, preview FROM threads WHERE id = ?').get(threadId);
    const title = preferredTitle(row);
    titleCache.set(threadId, title);
    return title;
  } catch {
    titleCache.set(threadId, '');
    return '';
  } finally {
    try { db?.close(); } catch { /* database may not have opened */ }
  }
}

export function statusSessionKey(processId, session) {
  if (session?.statusId) return sha256Key(['session', session.statusId]);
  return sha256Key([
    'legacy-session',
    String(processId),
    session?.host || '',
    session?.username || '',
    String(session?.port ?? ''),
    String(session?.connectedAt ?? ''),
  ]);
}

export function statusPendingKey(processId, pending) {
  if (pending?.pendingId) return sha256Key(['pending', pending.pendingId]);
  return sha256Key([
    'legacy-pending',
    String(processId),
    pending?.host || '',
    pending?.username || '',
    String(pending?.port ?? ''),
    String(pending?.startedAt ?? ''),
  ]);
}

function sha256Key(parts) {
  return crypto.createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex');
}

function isMissingOrGeneratedLabel(label) {
  return typeof label !== 'string' || !label.trim() || /^窗口-/u.test(label.trim());
}

function getTitleRow(stateDb, threadId, cache) {
  if (cache.has(threadId)) return cache.get(threadId);
  let title = '';
  try {
    title = preferredTitle(stateDb.prepare('SELECT name, title, preview FROM threads WHERE id = ?').get(threadId));
  } catch {
    title = '';
  }
  cache.set(threadId, title);
  return title;
}

export function backfillLegacyChatTitles({ statusDirectory, labelsPath } = {}) {
  if (!DatabaseSync) return { matched: 0, reason: 'This Node version does not include node:sqlite.' };

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const statusDir = statusDirectory || path.join(appData, 'CodexSSH', 'status');
  const outputPath = labelsPath || path.join(appData, 'CodexSSH', 'chat-labels.json');
  const home = codexHome();
  const statePath = latestDatabase(home, 'state');
  const historyPath = latestDatabase(home, 'thread_history');
  if (!statePath || !historyPath || !fs.existsSync(statusDir)) return { matched: 0, reason: 'Codex status or history database is unavailable.' };

  const missing = [];
  try {
    for (const name of fs.readdirSync(statusDir).filter((entry) => /^mcp-\d+\.json$/u.test(entry))) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(path.join(statusDir, name), 'utf8'));
        for (const session of snapshot.sessions || []) {
          if (isMissingOrGeneratedLabel(session.chatLabel)) {
            missing.push({ processId: snapshot.processId, session, key: statusSessionKey(snapshot.processId, session) });
          }
        }
      } catch {
        // Ignore an MCP snapshot while it is being rewritten.
      }
    }
  } catch {
    return { matched: 0, reason: 'Could not read MCP status snapshots.' };
  }
  if (!missing.length) return { matched: 0, reason: 'No unlabeled SSH sessions were found.' };

  let stateDb;
  let historyDb;
  try {
    stateDb = new DatabaseSync(statePath, { readOnly: true });
    historyDb = new DatabaseSync(historyPath, { readOnly: true });

    const hosts = [...new Set(missing.map((item) => item.session.host).filter(Boolean))];
    const candidates = [];
    for (const host of hosts) {
      const calls = historyDb.prepare(
        "SELECT thread_id, created_at_ms, item_json FROM thread_items WHERE item_type = 'mcpToolCall' AND item_json LIKE ? AND item_json LIKE ?",
      ).all(`%${host}%`, '%ssh_connect%');
      for (const call of calls) {
        try {
          const item = JSON.parse(call.item_json);
          const args = item.arguments || {};
          if (item.tool !== 'ssh_connect' || args.host !== host) continue;
          candidates.push({
            threadId: call.thread_id,
            createdAt: Number(call.created_at_ms),
            host: args.host,
            username: args.username,
            port: Number(args.port || 22),
            title: getTitleRow(stateDb, call.thread_id, titleCache),
          });
        } catch {
          // Ignore malformed or non-SSH tool-history rows.
        }
      }
    }

    const labels = Object.create(null);
    try {
      if (fs.existsSync(outputPath)) Object.assign(labels, JSON.parse(fs.readFileSync(outputPath, 'utf8')));
    } catch { /* ignore corrupt previous label map; rebuild available matches */ }

    let matched = 0;
    const usedCalls = new Set();
    for (const item of missing) {
      const session = item.session;
      const sessionTime = Number(session.connectedAt || 0);
      const possible = candidates
        .filter((candidate) => candidate.host === session.host
          && candidate.username === session.username
          && candidate.port === Number(session.port)
          && candidate.title
          && Math.abs(candidate.createdAt - sessionTime) <= 10 * 60 * 1000)
        .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.createdAt - sessionTime) }))
        .sort((left, right) => left.distance - right.distance);

      if (!possible.length) continue;
      const best = possible[0];
      const ambiguous = possible.slice(1).some((candidate) => candidate.threadId !== best.threadId
        && candidate.distance - best.distance < 3000);
      if (ambiguous) continue;

      const callKey = `${best.threadId}:${best.createdAt}`;
      if (usedCalls.has(callKey)) continue;
      usedCalls.add(callKey);
      labels[item.key] = best.title;
      matched += 1;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tempPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(labels, null, 2)}\n`, { encoding: 'utf8' });
    fs.renameSync(tempPath, outputPath);
    return { matched, reason: matched ? 'Matched legacy sessions to Codex chat titles.' : 'No unambiguous history matches were found.' };
  } catch (error) {
    return { matched: 0, reason: error.message };
  } finally {
    try { stateDb?.close(); } catch { /* ignore close errors */ }
    try { historyDb?.close(); } catch { /* ignore close errors */ }
  }
}
