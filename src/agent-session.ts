// AgentSession — persistent agent runtime as a Cloudflare Durable Object
// One DO per agent identity (one per channel user by default).
// Holds conversation history, skill state, and memory in SQLite.
// Equivalent to OpenClaw's per-agent SQLite + runtime context.

import type { Env } from './types.js';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const SYSTEM_PROMPT = `You are a persistent personal AI assistant running on Cloudflare Workers.
You have memory across conversations. Be direct, helpful, and concise.
When you don't know something, say so. When you can act, act.`;

const MAX_HISTORY = 20;

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

    if (url.pathname === '/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }
    if (url.pathname === '/memory' && request.method === 'GET') {
      return this.getMemory();
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleChat(request: Request): Promise<Response> {
    const { message, channel } = await request.json<{ message: string; channel: string }>();

    // Load recent history
    const rows = this.sql.exec<{ role: string; content: string }>(
      `SELECT role, content FROM messages ORDER BY id DESC LIMIT ${MAX_HISTORY}`
    ).toArray().reverse();

    const history: Message[] = rows.map(r => ({ role: r.role as Message['role'], content: r.content }));

    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message },
    ];

    // Run via Workers AI
    const model = (this.env.WORKERS_AI_MODEL ?? '@cf/meta/llama-4-scout-17b-16e-instruct') as Parameters<Ai['run']>[0];
    const result = await this.env.AI.run(model, { messages } as AiTextGenerationInput);
    const reply = typeof result === 'object' && 'response' in result
      ? (result as { response: string }).response
      : String(result);

    // Persist exchange
    this.sql.exec(
      `INSERT INTO messages (role, content) VALUES (?, ?), (?, ?)`,
      'user', message, 'assistant', reply
    );

    // Trim history beyond MAX_HISTORY * 2
    this.sql.exec(
      `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_HISTORY * 2})`
    );

    return Response.json({ reply, channel });
  }

  private getMemory(): Response {
    const rows = this.sql.exec<{ key: string; value: string }>(
      `SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 50`
    ).toArray();
    return Response.json({ memory: rows });
  }
}
