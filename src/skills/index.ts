// Skills — tools the agent can call during a conversation turn.
// Each skill maps to a CF Workers AI tool definition.
// Add new skills here; they're automatically available to the agent.

export interface SkillContext {
  sql: SqlStorage;
  env: { DB: D1Database };
}

interface SkillParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface Skill {
  name: string;
  description: string;
  parameters: SkillParameters;
  execute: (args: Record<string, string>, ctx: SkillContext) => Promise<string>;
}

export const skills: Skill[] = [
  {
    name: 'remember',
    description: 'Save a fact or piece of information to long-term memory. Use when the user explicitly asks you to remember something, or when you learn something important about them.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short identifier for this memory (e.g. "user_name", "preferred_language")' },
        value: { type: 'string', description: 'The information to remember' },
      },
      required: ['key', 'value'],
    },
    execute: async ({ key, value }, { sql }) => {
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
    description: 'Look up something from long-term memory. Use when you need to retrieve a specific fact you previously saved.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The memory key to look up' },
      },
      required: ['key'],
    },
    execute: async ({ key }, { sql }) => {
      const row = sql.exec<{ value: string }>(`SELECT value FROM memory WHERE key = ?`, key).one();
      return row ? row.value : `No memory found for key: ${key}`;
    },
  },

  {
    name: 'list_memories',
    description: 'List all saved memories. Use when the user asks what you remember about them.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_args, { sql }) => {
      const rows = sql.exec<{ key: string; value: string; updated_at: string }>(
        `SELECT key, value, updated_at FROM memory ORDER BY updated_at DESC LIMIT 20`,
      ).toArray();
      if (rows.length === 0) return 'No memories saved yet.';
      return rows.map(r => `${r.key}: ${r.value}`).join('\n');
    },
  },
];

// Convert skills to Workers AI tool definitions
export function skillsAsTools() {
  return skills.map(s => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    },
  }));
}
