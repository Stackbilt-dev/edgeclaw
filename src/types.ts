export interface Env {
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  DB: D1Database;

  EDGECLAW_ENV: string;
  WORKERS_AI_MODEL: string;

  // Channel secrets
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
}
