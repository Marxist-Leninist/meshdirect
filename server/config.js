// MeshDirect configuration from environment.
'use strict';

function bool(value, dflt) {
  if (value === undefined || value === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(value));
}
function int(value, dflt, min, max) {
  const n = Number.parseInt(value, 10);
  const chosen = Number.isFinite(n) ? n : dflt;
  return Math.max(min == null ? Number.MIN_SAFE_INTEGER : min, Math.min(max == null ? Number.MAX_SAFE_INTEGER : max, chosen));
}

const env = process.env;
const basePath = env.BASE_PATH || '/qwen38';

const DEFAULT_SYSTEM_PROMPT = [
  'You are Qwen 3.8 Mesh running inside MeshDirect, a custom autonomous agent harness.',
  'You have native tools named exec, read_file, write_file, list_files, web_fetch, and sg_mcp.',
  'Use tools yourself whenever they are needed. Do not merely print tool syntax and never emit XML such as <tool_call>.',
  'The sg_mcp tool gives live access to the complete SG1 and SG2 MCP catalogs: search for a tool, inspect its schema when needed, then call it.',
  'Continue through tool calls until the user request is actually completed or a concrete external blocker is proven.',
  'Report actions honestly. Never claim a command, edit, deployment, test, or remote operation happened unless a tool result confirms it.',
  'Do not reveal passwords, API keys, private keys, access tokens, or credential-file contents.',
  'Answer directly and keep routine narration brief, while showing useful execution state through tool events.',
].join(' ');

const config = {
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 31841, 1, 65535),
  basePath,

  username: env.APP_USERNAME || '',
  passwordHash: env.APP_PASSWORD_HASH || '',
  sessionTtlMs: int(env.SESSION_TTL_MS, 43200000, 60000, 30 * 86400000),
  cookieSecure: bool(env.COOKIE_SECURE, true),
  cookiePath: env.COOKIE_PATH || basePath,
  originAllow: (env.ORIGIN_ALLOW || env.PUBLIC_ORIGIN || 'https://zqx.lat')
    .split(',').map((s) => s.trim()).filter(Boolean),

  modelLabel: env.MODEL_LABEL || 'Qwen 3.8 Mesh',
  planLabel: env.PLAN_LABEL || 'Preview · Token Plan',
  workspaceLabel: env.WORKSPACE_LABEL || 'Stable · Token Plan',

  lanes: {
    preview: {
      label: 'Qwen 3.8 Preview',
      detail: 'Autonomous MeshDirect agent · SG1/SG2 tools',
      agent: 'qwen38-preview',
      modelId: env.PREVIEW_MODEL_ID || 'qwen3.8-max-preview',
    },
    stable: {
      label: 'Qwen 3.8',
      detail: 'Autonomous MeshDirect agent · stable model',
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
      resolverId: env.KEY_RESOLVER_ID || 'alibaba/token-plan/qwen38-preview',
    },
    fallback: {
      name: 'alibaba_free_ws',
      baseUrl: env.FALLBACK_BASE_URL || 'https://ws-cigeu9sl07kxfsxh.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      keyFile: env.FALLBACK_KEY_FILE || '/etc/meshdirect-fallback-key',
    },
  },

  contextTokens: int(env.CONTEXT_TOKENS, 262144, 8192, 2000000),
  maxOutputTokens: int(env.MAX_OUTPUT_TOKENS, 32768, 256, 131072),
  systemPrompt: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  historyContextMessages: int(env.HISTORY_CONTEXT_MESSAGES, 60, 1, 300),
  historyContextMaxChars: int(env.HISTORY_CONTEXT_MAX_CHARS, 220000, 1000, 1000000),

  maxAgentSteps: int(env.MAX_AGENT_STEPS, 32, 1, 128),
  maxToolCallsPerStep: int(env.MAX_TOOL_CALLS_PER_STEP, 8, 1, 32),
  maxToolCallsPerTurn: int(env.MAX_TOOL_CALLS_PER_TURN, 64, 1, 512),
  maxIdenticalToolCalls: int(env.MAX_IDENTICAL_TOOL_CALLS, 3, 1, 20),
  toolTimeoutMs: int(env.TOOL_TIMEOUT_MS, 120000, 1000, 120000),
  toolOutputMaxChars: int(env.TOOL_OUTPUT_MAX_CHARS, 60000, 1000, 100000),
  toolContextMaxChars: int(env.TOOL_CONTEXT_MAX_CHARS, 40000, 1000, 100000),
  maxWriteChars: int(env.MAX_WRITE_CHARS, 1000000, 1000, 5000000),
  sgMcpCli: env.SG_MCP_CLI || '/usr/local/bin/qwen38-mcp',

  connectTimeoutMs: int(env.CONNECT_TIMEOUT_MS, 10000, 1000, 120000),
  stallTimeoutMs: int(env.STALL_TIMEOUT_MS, 60000, 5000, 300000),
  turnTimeoutMs: int(env.TURN_TIMEOUT_MS, 1800000, 10000, 7200000),

  sessionsDir: env.SESSIONS_DIR || '/opt/meshdirect/sessions',
  distDir: env.DIST_DIR || '/opt/meshdirect/dist',
  workspaceRoot: env.WORKSPACE_ROOT || '/opt/meshdirect/workspaces',
  tmpDir: env.TMP_DIR || '/opt/meshdirect/tmp',

  httpsProxy: env.HTTPS_PROXY || env.https_proxy || '',
  noProxy: (env.NO_PROXY || env.no_proxy || '127.0.0.1,localhost,::1').split(',').map((s) => s.trim()).filter(Boolean),

  jobRetentionMs: int(env.JOB_RETENTION_MS, 30 * 60 * 1000, 60000, 24 * 60 * 60 * 1000),
  ssePingMs: int(env.SSE_PING_MS, 15000, 5000, 60000),
  maxQueuePerLane: int(env.MAX_QUEUE_PER_LANE, 4, 0, 50),
};

config.cookieName = config.cookieSecure ? '__Secure-qwen_mesh_session' : 'qwen_mesh_session';

if (!config.username || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(config.passwordHash)) {
  console.error('[meshdirect] FATAL: APP_USERNAME / APP_PASSWORD_HASH (bcrypt) missing or invalid');
  process.exit(1);
}

module.exports = config;
