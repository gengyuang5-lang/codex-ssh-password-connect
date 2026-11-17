import { backfillLegacyChatTitles } from './chat-titles.js';

const result = backfillLegacyChatTitles();
process.stdout.write(`Codex chat-title backfill: ${result.matched} matched. ${result.reason}\n`);
