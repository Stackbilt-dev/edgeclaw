// AgentSession — persistent agent runtime as a Cloudflare Durable Object.
// One DO per agent identity (keyed by channel + user ID).
// SQLite-backed conversation history + memory. LLM via @stackbilt/llm-providers.

import { LLMProviders } from '@stackbilt/llm-providers';
import { skills, skillsAsTools, type SkillContext } from './skills/index.js';
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
    if (url.pathname === '/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/memory' && request.method === 'GET') return this.getMemory();
    if (url.pathname === '/history' && request.method === 'GET') return this.getHistory();
    return new Response('Not found', { status: 404 });
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

    const model = this.env.WORKERS_AI_MODEL ?? DEFAULT_MODEL;
    const llm = LLMProviders.fromEnv(this.env as unknown as Record<string, unknown>);

    const skillCtx: SkillContext = { sql: this.sql, env: this.env };

    // Run with tool calling — agent can remember/recall in a single turn
    let reply = '';
    const response = await llm.generateResponse({
      messages,
      model,
      maxTokens: 1024,
      tools: skillsAsTools(),
    });

    // Execute any tool calls the model made
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults: string[] = [];
      for (const call of response.toolCalls) {
        const skill = skills.find(s => s.name === call.function.name);
        if (skill) {
          const args = typeof call.function.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
          const result = await skill.execute(args as Record<string, string>, skillCtx);
          toolResults.push(result);
        }
      }

      // Second pass: get final reply with tool results in context
      const finalResponse = await llm.generateResponse({
        messages: [
          ...messages,
          { role: 'assistant' as const, content: response.message || '' },
          { role: 'user' as const, content: `Tool results:\n${toolResults.join('\n')}` },
        ],
        model,
        maxTokens: 1024,
      });
      reply = finalResponse.message;
    } else {
      reply = response.message;
    }

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
