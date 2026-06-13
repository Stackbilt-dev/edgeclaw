// Telegram channel adapter
// Wire up: set your bot webhook to https://your-worker.workers.dev/channels/telegram
//
// Setup:
//   1. wrangler secret put TELEGRAM_BOT_TOKEN
//   2. wrangler secret put TELEGRAM_SECRET   (any random string)
//   3. curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//        -d "url=https://<your-worker>/channels/telegram&secret_token=<SECRET>"

import { Hono } from 'hono';
import type { Env } from '../types.js';

export const telegram = new Hono<{ Bindings: Env }>();

telegram.post('/channels/telegram', async (c) => {
  // Verify Telegram secret header
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!c.env.TELEGRAM_SECRET || secret !== c.env.TELEGRAM_SECRET) {
    return c.text('Unauthorized', 401);
  }

  const body = await c.req.json<TelegramUpdate>();
  const message = body.message ?? body.edited_message;
  if (!message?.text || !message.from) return c.text('ok');

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();

  // Route to the user's persistent AgentSession DO
  const sessionId = c.env.AGENT_SESSION.idFromName(`telegram:${userId}`);
  const session = c.env.AGENT_SESSION.get(sessionId);

  const response = await session.fetch('http://do/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, channel: 'telegram' }),
  });

  const { reply } = await response.json<{ reply: string }>();

  // Send reply back via Telegram Bot API
  await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN!, chatId, reply);

  return c.text('ok');
});

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

// Minimal Telegram update types
interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  text?: string;
  chat: { id: number };
  from?: { id: number; username?: string };
}
