// AgentSession — persistent agent runtime as a Cloudflare Durable Object.
// One DO per agent identity (keyed by channel + user ID).
// SQLite-backed conversation history + memory. LLM via CF Workers AI.

import { runWithTools } from '@cloudflare/ai-utils';
import { buildSkills } from './skills/index.js';
import type { Env } from './types.js';

const SYSTEM_PROMPT = `You are a persistent personal AI assistant running on Cloudflare's global network.
You have memory across conversations — use the remember/recall tools to save and retrieve important information.
Be direct, helpful, and concise. Act on requests; don't over-explain.`;

const MAX_HISTORY = 20;

const TOOL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

    const tools = buildSkills(this.sql);
    const model = TOOL_MODEL;

    // runWithTools handles the full tool-call loop: infer → execute → infer until done
    const response = await runWithTools(
      this.env.AI,
      model,
      { messages, tools },
    ) as { response?: string; result?: string } | string;

    const reply = typeof response === 'string'
      ? response
      : (response.response ?? response.result ?? '');

    this.sql.exec(
      `INSERT INTO messages (role, content) VALUES (?, ?), (?, ?)`,
      'user', message, 'assistant', reply,
    );

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
