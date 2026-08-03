// meshdirect — config from environment (dev: /etc/meshdirect-dev.env)
'use strict';

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const env = process.env;

const config = {
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 31841),
  basePath: env.BASE_PATH || '/qwen38',

  // auth
  username: env.APP_USERNAME || '',
  passwordHash: env.APP_PASSWORD_HASH || '',
  sessionTtlMs: int(env.SESSION_TTL_MS, 43200000),
  cookieSecure: bool(env.COOKIE_SECURE, true),
  cookiePath: env.COOKIE_PATH || (env.BASE_PATH || '/qwen38'),
  originAllow: (env.ORIGIN_ALLOW || env.PUBLIC_ORIGIN || 'https://zqx.lat')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // labels (drop-in parity)
  modelLabel: env.MODEL_LABEL || 'Qwen 3.8 Mesh',
  planLabel: env.PLAN_LABEL || 'Preview · Token Plan',
  workspaceLabel: env.WORKSPACE_LABEL || 'Stable · Token Plan',

  // models / lanes
  lanes: {
    preview: {
      label: 'Qwen 3.8 Preview',
      detail: 'Mesh supervisor with Stable handoff',
      agent: 'qwen38-preview',
      modelId: env.PREVIEW_MODEL_ID || 'qwen3.8-max-preview',
    },
    stable: {
      label: 'Qwen 3.8',
      detail: 'Direct stable model session',
      agent: 'qwen38-stable',
      modelId: env.STABLE_MODEL_ID || 'qwen3.8-max',
    },
  },
  providers: {
    primary: {
      name: 'alibaba_token_plan',
      baseUrl: env.PRIMARY_BASE_URL || 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      resolverPath: env.KEY_RESOLVER_PATH || '/usr/local/libexec/meshdirect-key-resolver',
      resolverProvider: env.KEY_RESOLVER_PROVIDER || 'meshdirect-vault',
      resolverId: 'alibaba/token-plan/qwen38-preview',
    },
    fallback: {
      name: 'alibaba_free_ws',
      baseUrl: env.FALLBACK_BASE_URL || 'https://ws-cigeu9sl07kxfsxh.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      keyFile: env.FALLBACK_KEY_FILE || '/etc/meshdirect-fallback-key',
    },
  },
  sgServers: {
    sg1: { url: env.SG1_MCP_URL || 'http://10.0.1.20:8095/mcp' },
    sg2: { url: env.SG2_MCP_URL || 'http://10.0.1.30:8095/mcp' },
  },
  contextTokens: 262144,
  maxOutputTokens: int(env.MAX_OUTPUT_TOKENS, 32768),
  systemPrompt: env.SYSTEM_PROMPT || [
    'You are Qwen 3.8 Mesh, a fully agentic coding and operations assistant.',
    'You have direct access to the live SG1 and SG2 MCP servers through the sg1 and sg2 function tools.',
    "Use action='search' to discover an unfamiliar MCP tool, then action='call' with its exact name and JSON arguments.",
    'Continue using tools until the request is actually complete and verify important effects.',
    'Never print <tool_call> markup or tool JSON as prose: invoke the supplied functions.',
    'Do not claim an action succeeded until its tool result confirms it. Answer directly and concisely.',
  ].join(' '),
  historyContextMessages: int(env.HISTORY_CONTEXT_MESSAGES, 50),
  historyContextMaxChars: int(env.HISTORY_CONTEXT_MAX_CHARS, 200000),
  maxAgentRounds: int(env.MAX_AGENT_ROUNDS, 12),
  maxToolCalls: int(env.MAX_TOOL_CALLS, 32),
  maxToolResultChars: int(env.MAX_TOOL_RESULT_CHARS, 60000),
  sgCallTimeoutMs: int(env.SG_CALL_TIMEOUT_MS, 150000),
  sgCatalogTtlMs: int(env.SG_CATALOG_TTL_MS, 60000),

  // timeouts
  connectTimeoutMs: int(env.CONNECT_TIMEOUT_MS, 10000),
  stallTimeoutMs: int(env.STALL_TIMEOUT_MS, 60000),
  turnTimeoutMs: int(env.TURN_TIMEOUT_MS, 600000),

  // storage
  sessionsDir: env.SESSIONS_DIR || '/opt/meshdirect/sessions',
  distDir: env.DIST_DIR || '/opt/meshdirect/dist',

  // proxy egress for model calls
  httpsProxy: env.HTTPS_PROXY || env.https_proxy || '',
  noProxy: (env.NO_PROXY || env.no_proxy || '127.0.0.1,localhost,::1').split(',').map((s) => s.trim()).filter(Boolean),

  jobRetentionMs: 15 * 60 * 1000,
  ssePingMs: int(env.SSE_PING_MS, 15000),
  maxQueuePerLane: 2,
};

config.cookieName = config.cookieSecure ? '__Secure-qwen_mesh_session' : 'qwen_mesh_session';

if (!config.username || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(config.passwordHash)) {
  console.error('[meshdirect] FATAL: APP_USERNAME / APP_PASSWORD_HASH (bcrypt) missing or invalid');
  process.exit(1);
}

module.exports = config;
