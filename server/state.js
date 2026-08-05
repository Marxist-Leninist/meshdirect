// /state payload — same shape as the legacy bridge-sourced StatePayload
'use strict';
const os = require('os');
const fs = require('fs');
const sessions = require('./sessions');

function hostStats() {
  let diskPercentUsed = 0, diskFreeGb = 0;
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    diskFreeGb = Math.round((free / 1e9) * 10) / 10;
    diskPercentUsed = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  } catch { /* best effort */ }
  const [load1, load5, load15] = os.loadavg();
  return {
    load1, load5, load15,
    uptimeSeconds: Math.floor(os.uptime()),
    memoryTotalMb: Math.round(os.totalmem() / 1048576),
    memoryAvailableMb: Math.round(os.freemem() / 1048576),
    diskPercentUsed, diskFreeGb,
    kernel: `${os.type()} ${os.release()}`,
  };
}

function buildState(config, jobs, startedAt) {
  const now = Date.now();
  const models = Object.keys(config.lanes).map((model) => {
    const laneCfg = config.lanes[model];
    const stats = sessions.statsFor(config, model, 'main');
    const lane = jobs.lanes[model];
    const live = jobs.live[model];
    const running = lane.running;
    const quietSeconds = live.lastActivityAt ? Math.floor((now - live.lastActivityAt) / 1000) : 0;
    return {
      model,
      label: laneCfg.label,
      agent: laneCfg.agent,
      sessionCount: 1,
      messageCount: stats.messageCount,
      lastActivityAt: stats.lastActivityAt,
      busy: !!running,
      turnElapsedSeconds: running && running.startedAt ? Math.floor((now - running.startedAt) / 1000) : null,
      progress: running ? {
        steps: live.steps,
        toolCalls: live.toolCalls,
        recentTools: live.recentTools,
        providerErrors: live.providerErrors,
        latestError: live.latestError,
        lastActivity: live.lastActivity,
        quietSeconds,
      } : null,
      stats: {
        contextTokens: config.contextTokens,
        totalTokens: stats.totalTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        lastPromptTokens: stats.lastPromptTokens,
        lastCompletionTokens: stats.lastCompletionTokens,
        lastTurnTokens: stats.lastTurnTokens,
        cacheRead: 0,
        cacheWrite: 0,
        compactionCount: 0,
        model: laneCfg.modelId,
        thinkingLevel: 'high',
        abortedLastRun: live.abortedLastRun,
      },
      lastError: live.lastError,
      sessions: [{
        sessionId: 'main',
        title: 'main',
        updatedAt: stats.lastActivityAt || 0,
        totalTokens: stats.totalTokens,
      }],
    };
  });
  return {
    harnessVersion: 'meshdirect 1.2',
    androidLink: { connectedClients: 0, retired: true },
    models,
    host: hostStats(),
    generatedAt: now,
    lanes: {
      preview: jobs.laneSnapshot('preview'),
      stable: jobs.laneSnapshot('stable'),
    },
    web: {
      uptimeSeconds: Math.floor((now - startedAt) / 1000),
      transport: 'in-process',
      plan: config.planLabel,
      workspace: config.workspaceLabel,
    },
  };
}

module.exports = { buildState };
