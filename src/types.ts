export interface Env {
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  SKILLS_KV: KVNamespace;

  // Runtime vars
  EDGECLAW_ENV: string;
  WORKERS_AI_MODEL: string;

  // Channel secrets (set via wrangler secret put)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
}
