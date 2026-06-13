// AgentSession — persistent agent runtime as a Cloudflare Durable Object.
// One DO per agent identity (keyed by channel + user ID).
// SQLite-backed conversation history + memory. LLM via @stackbilt/llm-providers.

import { LLMProviders } from '@stackbilt/llm-providers';
import type { SkillContext } from './skills/index.js';
import type { Env } from './types.js';

const SYSTEM_PROMPT = `You are a persistent personal AI assistant running on Cloudflare's global network.
You have memory across conversations — use the remember/recall tools to save and retrieve important information.
Be direct, helpful, and concise. Act on requests; don't over-explain.`;

const MAX_HISTORY = 20;

// Default model: tool calling + 131K context, free on Workers AI
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface MessageRow extends Record<string, SqlStorageValue> { role: string; content: string; }

export class AgentSession implements DurableObject {
  private sql: SqlStorage;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.sql = state.storage.sql;
    this.env = env;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/chat' && request.method === 'POST') return await this.handleChat(request);
      if (url.pathname === '/memory' && request.method === 'GET') return this.getMemory();
      if (url.pathname === '/history' && request.method === 'GET') return this.getHistory();
      return new Response('Not found', { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private async handleChat(request: Request): Promise<Response> {
    const { message, channel } = await request.json<{ message: string; channel: string }>();

    // Load recent history + pinned memories into context
    const history = this.sql.exec<MessageRow>(
      `SELECT role, content FROM messages ORDER BY id DESC LIMIT ${MAX_HISTORY}`,
    ).toArray().reverse();

    const pinned = this.sql.exec<{ key: string; value: string }>(
      `SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 10`,
    ).toArray();

    const memoryContext = pinned.length > 0
      ? `\n\nWhat you remember about this user:\n${pinned.map(m => `- ${m.key}: ${m.value}`).join('\n')}`
      : '';

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT + memoryContext },
      ...history.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content })),
      { role: 'user' as const, content: message },
    ];

    // Run pre-LLM skill intercepts — pattern-match before spending tokens.
    // Workers AI sets content=null on tool-call responses, which trips schema validation.
    const skillCtx: SkillContext = { sql: this.sql, env: this.env };
    const intercepted = await interceptSkills(message, skillCtx);
    if (intercepted !== null) {
      return Response.json({ reply: intercepted, channel, model: 'skill:intercept' });
    }

    const model = this.env.WORKERS_AI_MODEL ?? DEFAULT_MODEL;
    const llm = LLMProviders.fromEnv(this.env as unknown as Record<string, unknown>);

    const response = await llm.generateResponse({ messages, model, maxTokens: 512 });
    const reply = response.message;

    // Persist exchange
    this.sql.exec(
      `INSERT INTO messages (role, content) VALUES (?, ?), (?, ?)`,
      'user', message, 'assistant', reply,
    );

    // Trim beyond MAX_HISTORY * 2
    this.sql.exec(
      `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_HISTORY * 2})`,
    );

    return Response.json({ reply, channel, model });
  }

  private getMemory(): Response {
    const rows = this.sql.exec<{ key: string; value: string; updated_at: string }>(
      `SELECT key, value, updated_at FROM memory ORDER BY updated_at DESC`,
    ).toArray();
    return Response.json({ memory: rows });
  }

  private getHistory(): Response {
    const rows = this.sql.exec<MessageRow>(
      `SELECT role, content FROM messages ORDER BY id DESC LIMIT 50`,
    ).toArray().reverse();
    return Response.json({ messages: rows });
  }
}

// Pattern-match common memory operations before spending LLM tokens.
// Workers AI sets content=null on tool-call responses, tripping schema validation,
// so we intercept explicit memory commands here instead of using tool calling.
async function interceptSkills(message: string, ctx: SkillContext): Promise<string | null> {
  const lower = message.toLowerCase().trim();

  // "remember X is Y" / "remember that X"
  const rememberMatch = lower.match(/^remember\s+(?:that\s+)?(.+?)\s+is\s+(.+)$/i)
    ?? message.match(/^remember\s+(?:that\s+)?(.+?)\s+is\s+(.+)$/i);
  if (rememberMatch) {
    const key = rememberMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
    const value = rememberMatch[2].trim();
    ctx.sql.exec(
      `INSERT INTO memory (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value,
    );
    return `Got it — I'll remember that ${rememberMatch[1]} is ${value}.`;
  }

  // "what do you remember" / "list memories"
  if (/what do you remember|list memories|what have you remembered/i.test(lower)) {
    const rows = ctx.sql.exec<{ key: string; value: string }>(
      `SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 20`,
    ).toArray();
    if (rows.length === 0) return "I don't have anything saved to memory yet.";
    return `Here's what I remember:\n${rows.map(r => `- ${r.key}: ${r.value}`).join('\n')}`;
  }

  // "forget X"
  const forgetMatch = lower.match(/^forget\s+(.+)$/i);
  if (forgetMatch) {
    const key = forgetMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
    ctx.sql.exec(`DELETE FROM memory WHERE key = ?`, key);
    return `Forgotten: ${key}.`;
  }

  return null;
}
