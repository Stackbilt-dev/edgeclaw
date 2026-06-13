// Skills — CF Workers AI embedded function calling tools.
// Each skill is self-contained: description, parameters, and the executor function.
// runWithTools() calls the function inline — no separate ToolExecutor pattern needed.

import type { SqlStorage } from '@cloudflare/workers-types';

export interface CfTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function: (args: any) => Promise<string>;
}

export function buildSkills(sql: SqlStorage): CfTool[] {
  return [
    {
      name: 'remember',
      description: 'Save a fact to long-term memory. Use when the user asks you to remember something or when you learn something important about them.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short identifier, e.g. "user_name" or "preferred_language"' },
          value: { type: 'string', description: 'The information to remember' },
        },
        required: ['key', 'value'],
      },
      function: async ({ key, value }: { key: string; value: string }) => {
        sql.exec(
          `INSERT INTO memory (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          key, value,
        );
        return `Remembered: ${key} = ${value}`;
      },
    },

    {
      name: 'recall',
      description: 'Look up a specific fact from long-term memory.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The memory key to look up' },
        },
        required: ['key'],
      },
      function: async ({ key }: { key: string }) => {
        const row = sql.exec<{ value: string }>(`SELECT value FROM memory WHERE key = ?`, key).toArray()[0];
        return row ? row.value : `No memory found for key: ${key}`;
      },
    },

    {
      name: 'list_memories',
      description: 'List everything saved in long-term memory. Use when the user asks what you remember about them.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      function: async () => {
        const rows = sql.exec<{ key: string; value: string }>(
          `SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 20`,
        ).toArray();
        if (rows.length === 0) return 'No memories saved yet.';
        return rows.map(r => `${r.key}: ${r.value}`).join('\n');
      },
    },
  ];
}
