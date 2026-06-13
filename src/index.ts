import { Hono } from 'hono';
import { AgentSession } from './agent-session.js';
import { telegram } from './channels/telegram.js';
import { slack } from './channels/slack.js';
import type { Env } from './types.js';

export { AgentSession };

const app = new Hono<{ Bindings: Env }>();

// Channel adapters
app.route('/', telegram);
app.route('/', slack);

// Health
app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

// Direct HTTP chat (for testing / REST clients)
app.post('/chat', async (c) => {
  const { message, agent_id = 'default' } = await c.req.json<{ message: string; agent_id?: string }>();
  if (!message) return c.json({ error: 'message required' }, 400);

  const sessionId = c.env.AGENT_SESSION.idFromName(agent_id);
  const session = c.env.AGENT_SESSION.get(sessionId);

  const response = await session.fetch('http://do/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel: 'http' }),
  });

  return response;
});

export default app;
