// Slack channel adapter
// Wire up: set your Slack app's Event Subscriptions URL to
//          https://your-worker.workers.dev/channels/slack
//
// Setup:
//   1. wrangler secret put SLACK_SIGNING_SECRET
//   2. wrangler secret put SLACK_BOT_TOKEN
//   3. Enable Events API in Slack app → subscribe to message.im

import { Hono } from 'hono';
import type { Env } from '../types.js';

export const slack = new Hono<{ Bindings: Env }>();

slack.post('/channels/slack', async (c) => {
  const rawBody = await c.req.text();

  // Verify Slack signature
  if (!await verifySlackSignature(c.req.raw, rawBody, c.env.SLACK_SIGNING_SECRET ?? '')) {
    return c.text('Unauthorized', 401);
  }

  const body = JSON.parse(rawBody) as SlackEvent;

  // Slack URL verification challenge
  if (body.type === 'url_verification') {
    return c.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event || event.type !== 'message' || event.bot_id || !event.text) {
    return c.text('ok');
  }

  const userId = event.user;
  const channel = event.channel;

  // Route to user's persistent AgentSession DO
  const sessionId = c.env.AGENT_SESSION.idFromName(`slack:${userId}`);
  const session = c.env.AGENT_SESSION.get(sessionId);

  // Fire-and-forget — Slack expects <3s response
  c.executionCtx.waitUntil((async () => {
    const response = await session.fetch('http://do/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: event.text, channel: 'slack' }),
    });
    const { reply } = await response.json<{ reply: string }>();
    await sendSlackMessage(c.env.SLACK_BOT_TOKEN!, channel, reply);
  })());

  return c.text('ok');
});

async function sendSlackMessage(token: string, channel: string, text: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
}

async function verifySlackSignature(request: Request, body: string, secret: string): Promise<boolean> {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') ?? '';
  const signature = request.headers.get('X-Slack-Signature') ?? '';
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
  const computed = 'v0=' + Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === signature;
}

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    text?: string;
    user: string;
    channel: string;
    bot_id?: string;
  };
}
