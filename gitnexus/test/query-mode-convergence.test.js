import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQueryMode } from '../dist/mcp/local/query-mode.js';

const clampInteger = (value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const toFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

test('runQueryMode reranks slices/processes using convergence matrix signals', async () => {
  const repo = {
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const queryResult = {
    query_plan: {
      exact_lookup: { hits: 1, used: true },
    },
    slice_cards: [
      {
        uid: 'slice-alpha',
        label: 'Account Settings Slice',
        slice_type: 'endpoint',
        anchor_id: 'anchor-alpha',
        anchor_name: 'AccountSettings',
        roles: ['controller'],
        gap_signals: { high: 0, deterministic: 0 },
        matched_members: [
          {
            uid: 'member-alpha',
            name: 'AccountSettingsPage',
            filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
          },
        ],
      },
      {
        uid: 'slice-beta',
        label: 'Notifications Api Slice',
        slice_type: 'endpoint',
        anchor_id: 'anchor-beta',
        anchor_name: 'NotificationsApi',
        roles: ['api'],
        gap_signals: { high: 0, deterministic: 0 },
        matched_members: [
          {
            uid: 'member-beta',
            name: 'fetchAccountNotifications',
            filePath: 'apps/dashboard/src/api/notifications.ts',
          },
        ],
      },
    ],
    processes: [
      {
        id: 'proc-alpha',
        summary: 'Account settings flow',
        process_type: 'cross-stack',
      },
      {
        id: 'proc-beta',
        summary: 'Notifications fetch flow',
        process_type: 'cross-stack',
      },
    ],
    process_symbols: [
      {
        process_id: 'proc-alpha',
        filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
        name: 'AccountSettingsPage',
      },
      {
        process_id: 'proc-beta',
        filePath: 'apps/dashboard/src/api/notifications.ts',
        name: 'fetchAccountNotifications',
      },
    ],
    definitions: [],
  };

  const matrix = {
    sourcePath: '/tmp/test/lamination_matrix.json',
    loadedAt: new Date().toISOString(),
    cells: [
      {
        cluster: 'Api',
        signature: 'FE:Page -> FE:Api -> HTTP:GET -> BE:Controller',
        score: 95,
        route: 'http-get:/api/user/accounts/*',
        tokenSet: new Set(['api', 'notifications', 'fetch', 'account']),
        exemplarFilePaths: ['apps/dashboard/src/api/notifications.ts'],
      },
      {
        cluster: 'Settings',
        signature: 'FE:Page -> FE:Component',
        score: 30,
        route: '',
        tokenSet: new Set(['settings', 'account']),
        exemplarFilePaths: ['apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx'],
      },
    ],
  };

  const result = await runQueryMode(
    {
      query: async () => queryResult,
      precedents: async () => ({ precedents: [] }),
      actionPlan: async () => ({ files: [], checks: [], hops: [] }),
      parsePathPrefixes: () => [],
      clampInteger,
      toFiniteNumber,
      loadConvergenceMatrix: async () => matrix,
    },
    repo,
    {
      query: 'fetch account notifications api flow',
      limit_processes: 2,
      limit_slices: 2,
      include_precedents: false,
      include_action_hints: true,
    },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.query_mode.processes[0].id, 'proc-beta');
  assert.equal(result.query_mode.slices[0].uid, 'slice-beta');
  assert.equal(result.query_mode.symbols[0].name, 'fetchAccountNotifications');
  assert.ok((result.query_mode.symbols[0]?.carbon_copy_hint?.score || 0) > 0);

  assert.equal(result._query_mode?.convergence?.enabled, true);
  assert.equal(result._query_mode?.convergence?.process_reordered, true);
  assert.equal(result._query_mode?.convergence?.slice_reordered, true);
  assert.equal(result._query_mode?.convergence?.symbol_reordered, true);
  assert.ok(result._query_mode?.convergence?.processes_boosted >= 1);
  assert.ok(result._query_mode?.convergence?.slices_boosted >= 1);
  assert.ok(result._query_mode?.convergence?.symbols_boosted >= 1);
  assert.equal(result._query_mode?.convergence?.top_symbol_signal?.name, 'fetchAccountNotifications');
  assert.ok((result._query_mode?.convergence?.top_symbol_signal?.score || 0) > 0);
  assert.ok((result._query_mode?.convergence?.symbol_ranking_weights?.lexical || 0) > 0);
  assert.ok((result._query_mode?.convergence?.next_action_ranking_weights?.score || 0) > 0);
  assert.ok(
    ['symbol', 'carbon_anchor', 'process'].includes(String(result._query_mode?.convergence?.prioritized_next_action?.source || '')),
    'expected prioritized next action source',
  );
  assert.ok(
    typeof result._query_mode?.convergence?.prioritized_next_action?.candidate_origin === 'string',
    'expected prioritized next action candidate origin',
  );
  assert.ok(
    typeof result._query_mode?.convergence?.prioritized_next_action?.reason_code === 'string',
    'expected prioritized next action reason code',
  );
  assert.ok(
    typeof result._query_mode?.convergence?.prioritized_next_action?.confidence === 'number',
    'expected prioritized next action confidence',
  );
  assert.equal(
    result._query_mode?.convergence?.prioritized_next_action?.action,
    result.query_mode?.next_actions?.[0],
  );
  assert.ok(
    typeof result._query_mode?.convergence?.next_action_gates?.retrieval_signal === 'number',
    'expected next action gate diagnostics',
  );
  assert.equal(
    typeof result._query_mode?.convergence?.first_action_coverage?.prioritized_action_present,
    'boolean',
  );
  assert.ok(result.query_mode?.carbon_copy_ready, 'expected carbon_copy_ready summary');
  assert.ok((result.query_mode?.carbon_copy_ready?.score || 0) > 0);
  assert.ok(result._query_mode?.convergence?.top_carbon_copy, 'expected top_carbon_copy convergence metadata');
  assert.ok((result.query_mode?.slices?.[0]?.carbon_copy_ready?.score || 0) > 0);
});

test('runQueryMode uses lexical fallback for symbol ranking when convergence is unavailable', async () => {
  const repo = {
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const queryResult = {
    query_plan: {
      exact_lookup: { hits: 0, used: false },
    },
    slice_cards: [],
    processes: [],
    process_symbols: [
      {
        process_id: '',
        filePath: 'apps/backend/app/Services/SeatingService.php',
        name: 'assignSeatingGroup',
      },
      {
        process_id: '',
        filePath: 'apps/backend/app/Services/PayoutService.php',
        name: 'listPayouts',
      },
    ],
    definitions: [],
  };

  const result = await runQueryMode(
    {
      query: async () => queryResult,
      precedents: async () => ({ precedents: [] }),
      actionPlan: async () => ({ files: [], checks: [], hops: [] }),
      parsePathPrefixes: () => [],
      clampInteger,
      toFiniteNumber,
      loadConvergenceMatrix: async () => null,
    },
    repo,
    {
      query: 'assign seating group',
      limit_processes: 2,
      limit_slices: 2,
      include_precedents: false,
      include_action_hints: false,
    },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.query_mode.symbols[0].name, 'assignSeatingGroup');
  assert.ok((result.query_mode.symbols[0]?.carbon_copy_hint?.score || 0) > 0);
  assert.ok((result._query_mode?.convergence?.symbols_boosted || 0) > 0);
  assert.equal(result._query_mode?.convergence?.enabled, false);
  assert.ok(result._query_mode?.convergence?.prioritized_next_action?.action);
  assert.equal(result._query_mode?.convergence?.prioritized_next_action?.source, 'symbol');
  assert.equal(
    result._query_mode?.convergence?.prioritized_next_action?.action,
    result.query_mode?.next_actions?.[0],
  );
  assert.equal(result._query_mode?.convergence?.first_action_coverage?.prioritized_action_present, true);
  assert.ok(
    typeof result._query_mode?.convergence?.first_action_coverage?.reason_code === 'string',
    'expected first-action coverage reason code',
  );
});

test('runQueryMode emits fallback prioritized action when adaptive thresholds reject all primary candidates', async () => {
  const repo = {
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const queryResult = {
    query_plan: {
      exact_lookup: { hits: 0, used: false },
    },
    slice_cards: [],
    processes: [],
    process_symbols: [
      {
        process_id: '',
        filePath: 'apps/backend/app/Services/LowSignalService.php',
        name: 'fallbackCandidate',
      },
    ],
    definitions: [],
  };

  const result = await runQueryMode(
    {
      query: async () => queryResult,
      precedents: async () => ({ precedents: [] }),
      actionPlan: async () => ({ files: [], checks: [], hops: [] }),
      parsePathPrefixes: () => [],
      clampInteger,
      toFiniteNumber,
      loadConvergenceMatrix: async () => null,
    },
    repo,
    {
      query: 'fallback candidate',
      include_precedents: false,
      include_action_hints: true,
    },
  );

  assert.equal(result.status, 'ok');
  assert.ok(result._query_mode?.convergence?.prioritized_next_action?.action);
  assert.equal(result._query_mode?.convergence?.prioritized_next_action?.source, 'symbol');
  assert.ok(
    String(result._query_mode?.convergence?.prioritized_next_action?.candidate_origin || '').startsWith('fallback_'),
    'expected fallback candidate origin',
  );
  assert.equal(result._query_mode?.convergence?.first_action_coverage?.prioritized_action_present, true);
});

test('runQueryMode calibrates next action from direct precedents when top slice drifts to generic api hotspot', async () => {
  const repo = {
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const queryResult = {
    query_plan: {
      exact_lookup: { hits: 0, used: false },
    },
    slice_cards: [
      {
        uid: 'slice-endpoint-paddle-raise-intents',
        label: 'Paddle Raise intents endpoint',
        slice_type: 'endpoint',
        anchor_id: 'anchor-paddle-raise-intents',
        anchor_name: 'PaddleRaiseIntentController',
        roles: ['controller'],
        gap_signals: { high: 0, deterministic: 0 },
        matched_members: [
          {
            uid: 'member-paddle-raise-intents',
            name: 'PaddleRaiseIntentController',
            filePath: 'apps/backend/app/Domains/PaddleRaise/Http/Controllers/PaddleRaiseIntentController.php',
          },
        ],
      },
    ],
    processes: [
      {
        id: 'proc-paddle-raise-intents',
        summary: 'Paddle Raise intent show flow',
        process_type: 'cross-stack',
      },
    ],
    process_symbols: [
      {
        process_id: 'proc-paddle-raise-intents',
        filePath: 'apps/backend/app/Domains/PaddleRaise/Http/Controllers/PaddleRaiseIntentController.php',
        name: 'show',
      },
    ],
    definitions: [],
  };

  const precedentCalls = [];
  const precedentsResult = {
    precedents: [
      {
        kind: 'ui-behavior',
        signature: 'settings:shared-tips-fees',
        score: 1.08,
        anchor: {
          title: 'Shared donor tips / platform fees settings UI',
          filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx',
        },
        examples: [
          {
            name: 'CampaignFeeSettings',
            filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
          },
        ],
      },
      {
        kind: 'backend-behavior',
        signature: 'paddle-raise:fees-config',
        score: 1.02,
        anchor: {
          title: 'Paddle Raise payment config quartet',
          filePath: 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php',
        },
      },
    ],
  };

  const result = await runQueryMode(
    {
      query: async () => queryResult,
      precedents: async (_repo, params) => {
        precedentCalls.push(params);
        return precedentsResult;
      },
      actionPlan: async () => ({
        files: [],
        checks: [],
        hops: [
          {
            http: {
              confidence: 0.92,
              reason: 'http-get:/api/campaigns/*/paddle_raise/intents/*',
            },
            ui: { name: 'fetchPaddleRaiseIntent' },
            controller: { name: 'PaddleRaiseIntentController::show' },
          },
        ],
      }),
      parsePathPrefixes: () => [],
      clampInteger,
      toFiniteNumber,
      loadConvergenceMatrix: async () => null,
    },
    repo,
    {
      query: 'Add Paddle Raise commitments dashboard settings using the same donor tips and platform fees UI and exact same options as campaign settings and auction settings',
      include_precedents: true,
      include_action_hints: true,
    },
  );

  assert.equal(result.status, 'ok');
  assert.equal(precedentCalls.length, 1);
  assert.equal(precedentCalls[0]?.anchor_uid, undefined);
  assert.equal(result.query_mode?.direct_precedent_anchor?.filePath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx');
  assert.match(String(result.query_mode?.next_actions?.[0] || ''), /AuctionSettings\.tsx|Shared donor tips/i);
  assert.equal(result._query_mode?.convergence?.prioritized_next_action?.source, 'precedent');
  assert.equal(result._query_mode?.convergence?.direct_precedent_recovery?.target_calibrated, true);
  assert.equal(result._query_mode?.convergence?.direct_precedent_recovery?.top_slice_looks_generic, true);
  assert.equal(
    result._query_mode?.convergence?.direct_precedent_recovery?.top_precedent?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx',
  );
  assert.equal(result.query_mode?.precedents?.[0]?.kind, 'ui-behavior');
});
