export const configFixture = {
  teamId: 'TTEST', ownerUserIds: ['UOWNER'], jevApiKeyEnv: 'JEV_API_KEY',
  budgets: { maxRuns: 20, maxTokens: 100000, maxCostUsd: 5, runTimeoutMs: 120000 },
  agents: [{ id: 'research', name: 'Research', role: 'Find evidence', slackAppId: 'AONE',
    slackUserId: 'UONE', slackBotId: 'BONE', botTokenEnv: 'RESEARCH_BOT_TOKEN', appTokenEnv: 'RESEARCH_APP_TOKEN',
    model: { provider: 'anthropic', id: 'configured-model', apiKeyEnv: 'MODEL_API_KEY' }, channels: { CTEST: 'mentions' as const } }],
};
