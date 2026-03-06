import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runImplementMode } from '../dist/mcp/local/implement-mode.js';

const clampInteger = (value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const toFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

test('runImplementMode reorders write plan and companions using query-head convergence', async () => {
  const repo = {
    id: 'repo-1',
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const result = await runImplementMode(
    {
      actionPlan: async () => ({
        implement_plan: {
          target: {
            query_intent: 'notifications flow',
            archetype: 'cross-stack',
            slice: 'Notifications',
          },
          companion_set: {
            files: [
              {
                filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
                score: 1,
                reasons: ['base-priority'],
                anchors: [],
              },
              {
                filePath: 'apps/dashboard/src/api/notifications.ts',
                score: 0.2,
                reasons: ['base-priority'],
                anchors: [],
              },
            ],
          },
          write_order: [
            {
              uid: 'step-ui',
              name: 'AccountSettingsPage',
              kind: 'Function',
              filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
              role: 'entry',
            },
            {
              uid: 'step-api',
              name: 'fetchAccountNotifications',
              kind: 'Function',
              filePath: 'apps/dashboard/src/api/notifications.ts',
              role: 'api',
            },
          ],
          precedents: [],
        },
        checks: ['Run focused tests'],
        hops: [],
        cache_effects: [],
        files: [],
      }),
      queryMode: async () => ({
        query_mode: {
          query_plan: { exact_lookup: { used: true, hits: 1 } },
          slices: [
            {
              uid: 'slice-notifications',
              matched_members: [
                {
                  uid: 'member-notifications',
                  name: 'fetchAccountNotifications',
                  filePath: 'apps/dashboard/src/api/notifications.ts',
                },
              ],
            },
          ],
          processes: [
            {
              id: 'proc-notifications',
              summary: 'Notifications fetch flow',
            },
          ],
          symbols: [
            {
              process_id: 'proc-notifications',
              filePath: 'apps/dashboard/src/api/notifications.ts',
              name: 'fetchAccountNotifications',
            },
          ],
          precedents: [],
        },
        _query_mode: {
          convergence: {
            enabled: true,
            source_path: '/tmp/lamination_matrix.json',
            matrix_cells: 11,
          },
        },
      }),
      getIndexStatus: async () => ({
        isStale: false,
        indexedAt: null,
        indexedCommit: null,
        headCommit: null,
        refreshCommandSandbox: null,
        refreshCommandSandboxForce: null,
      }),
      precedents: async () => ({ precedents: [] }),
      parsePathPrefixes: () => [],
      clampInteger,
      normalizeRepoRelativePath: value => String(value || '').replace(/^\.?\//, ''),
      toFiniteNumber,
    },
    repo,
    {
      query: 'notifications flow',
      include_query_head: true,
      include_review_contract: true,
      limit_files: 10,
      limit_write_order: 10,
      limit_checks: 10,
      limit_precedents: 3,
    },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.implement_mode.companion_files[0].filePath, 'apps/dashboard/src/api/notifications.ts');
  assert.equal(result.implement_mode.write_plan[0].filePath, 'apps/dashboard/src/api/notifications.ts');
  assert.ok(
    result.implement_mode.next_actions[0].includes('Start with converged write anchor'),
    'expected convergence-prioritized first next action',
  );

  assert.equal(result._implement_mode.convergence.enabled, true);
  assert.equal(result._implement_mode.convergence.source_path, '/tmp/lamination_matrix.json');
  assert.equal(result._implement_mode.convergence.matrix_cells, 11);
  assert.equal(result._implement_mode.convergence.companion_reordered, true);
  assert.equal(result._implement_mode.convergence.write_plan_reordered, true);
  assert.equal(result._implement_mode.convergence.companion_convergence_applied, true);
  assert.equal(result._implement_mode.convergence.write_plan_convergence_applied, true);
  assert.ok(result._implement_mode.convergence.ranking_weights);
  assert.ok((result._implement_mode.convergence.ranking_weights?.write_plan?.carbon || 0) > 0);
  assert.ok((result._implement_mode.convergence.next_action_ranking_weights?.rank_score || 0) > 0);
  const convergedRankScale = Number(
    Math.max(
      1,
      ...result.implement_mode.write_plan
        .filter(step => Number(step?.convergence?.boost || 0) > 0)
        .map(step => Number(step?.ranking?.score || 0)),
    ).toFixed(3),
  );
  assert.equal(result._implement_mode.convergence?.write_anchor_rank_scale, convergedRankScale);
  assert.equal(result._implement_mode.convergence?.prioritized_write_anchor?.source, 'converged');
  assert.equal(
    result._implement_mode.convergence?.prioritized_write_anchor?.next_action,
    result.implement_mode.next_actions[0],
  );
  assert.ok(result._implement_mode.convergence.companion_files_boosted >= 1);
  assert.ok(result._implement_mode.convergence.write_plan_boosted >= 1);
  assert.ok(result.implement_mode?.carbon_copy_ready, 'expected implement carbon_copy_ready');
  assert.ok((result.implement_mode?.carbon_copy_ready?.score || 0) > 0);
  assert.ok(result._implement_mode?.convergence?.carbon_copy_ready, 'expected convergence carbon_copy_ready');
  assert.ok((result.implement_mode?.write_plan?.[0]?.carbon_copy_ready?.score || 0) > 0);
  assert.ok((result.implement_mode?.companion_files?.[0]?.carbon_copy_ready?.score || 0) > 0);
});

test('runImplementMode reorders from precedent+carbon signals when convergence is unavailable', async () => {
  const repo = {
    id: 'repo-2',
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const result = await runImplementMode(
    {
      actionPlan: async () => ({
        implement_plan: {
          target: {
            query_intent: 'notifications flow',
            archetype: 'cross-stack',
            slice: 'Notifications',
          },
          companion_set: {
            files: [
              {
                filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
                score: 0.5,
                reasons: ['base-priority'],
                anchors: [],
              },
              {
                filePath: 'apps/dashboard/src/api/notifications.ts',
                score: 0.2,
                reasons: ['base-priority'],
                anchors: [],
              },
            ],
          },
          write_order: [
            {
              uid: 'step-ui',
              name: 'AccountSettingsPage',
              kind: 'Function',
              filePath: 'apps/dashboard/src/pages/account-settings/AccountSettingsPage.tsx',
              role: 'entry',
            },
            {
              uid: 'step-api',
              name: 'fetchAccountNotifications',
              kind: 'Function',
              filePath: 'apps/dashboard/src/api/notifications.ts',
              role: 'api',
            },
          ],
          precedents: [
            {
              kind: 'slice',
              signature: 'notifications-slice',
              anchor: {
                filePath: 'apps/dashboard/src/api/notifications.ts',
                name: 'fetchAccountNotifications',
                kind: 'Function',
              },
              examples: [],
            },
          ],
        },
        checks: ['Run focused tests'],
        hops: [],
        cache_effects: [],
        files: [],
      }),
      queryMode: async () => ({
        query_mode: {
          query_plan: { exact_lookup: { used: true, hits: 1 } },
          slices: [],
          processes: [],
          symbols: [],
          precedents: [],
        },
        _query_mode: {
          convergence: {
            enabled: false,
            source_path: null,
            matrix_cells: 0,
          },
        },
      }),
      getIndexStatus: async () => ({
        isStale: false,
        indexedAt: null,
        indexedCommit: null,
        headCommit: null,
        refreshCommandSandbox: null,
        refreshCommandSandboxForce: null,
      }),
      precedents: async () => ({ precedents: [] }),
      parsePathPrefixes: () => [],
      clampInteger,
      normalizeRepoRelativePath: value => String(value || '').replace(/^\.?\//, ''),
      toFiniteNumber,
    },
    repo,
    {
      query: 'notifications flow',
      include_query_head: true,
      include_review_contract: true,
      limit_files: 10,
      limit_write_order: 10,
      limit_checks: 10,
      limit_precedents: 3,
    },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result._implement_mode.convergence.enabled, false);
  assert.equal(result._implement_mode.convergence.companion_convergence_applied, false);
  assert.equal(result._implement_mode.convergence.write_plan_convergence_applied, false);
  assert.equal(result._implement_mode.convergence.companion_reordered, true);
  assert.equal(result._implement_mode.convergence.write_plan_reordered, true);
  const rankedScale = Number(
    Math.max(
      1,
      ...result.implement_mode.write_plan.map(step => Number(step?.ranking?.score || 0)),
    ).toFixed(3),
  );
  assert.equal(result._implement_mode.convergence?.write_anchor_rank_scale, rankedScale);
  assert.equal(result._implement_mode.convergence?.prioritized_write_anchor?.source, 'ranked');
  assert.equal(
    result._implement_mode.convergence?.prioritized_write_anchor?.next_action,
    result.implement_mode.next_actions[0],
  );
  assert.equal(result.implement_mode.companion_files[0].filePath, 'apps/dashboard/src/api/notifications.ts');
  assert.equal(result.implement_mode.write_plan[0].filePath, 'apps/dashboard/src/api/notifications.ts');
  assert.ok((result.implement_mode.companion_files[0]?.carbon_copy_ready?.score || 0) > 0);
  assert.ok((result.implement_mode.write_plan[0]?.carbon_copy_ready?.score || 0) > 0);
});

test('runImplementMode calibrates settings hotspot targets from direct precedents when planner anchors drift', async () => {
  const repo = {
    id: 'repo-3',
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
  };

  const result = await runImplementMode(
    {
      actionPlan: async () => ({
        implement_plan: {
          target: {
            query_intent: 'paddle raise settings donor tips platform fees',
            archetype: 'pattern-catalog:Contact combobox (infinite scroll + debounced search)',
            slice: 'FeatureSlice:slice_permission_paddle_raise_view',
          },
          companion_set: {
            files: [
              {
                filePath: 'apps/backend/app/Domains/AccessControl/Permissions/PaddleRaisePermission.php',
                score: 1,
                reasons: ['base-priority'],
                anchors: [],
              },
              {
                filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-event/paddle-raise/EditIntentDrawer.tsx',
                score: 0.8,
                reasons: ['base-priority'],
                anchors: [],
              },
            ],
          },
          write_order: [
            {
              uid: 'step-permission',
              name: 'PaddleRaisePermission',
              kind: 'Enum',
              filePath: 'apps/backend/app/Domains/AccessControl/Permissions/PaddleRaisePermission.php',
              role: 'permission',
            },
            {
              uid: 'step-intent-drawer',
              name: 'EditIntentDrawer',
              kind: 'Function',
              filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-event/paddle-raise/EditIntentDrawer.tsx',
              role: 'ui',
            },
          ],
          precedents: [],
        },
        checks: ['Run focused tests'],
        hops: [],
        cache_effects: [],
        files: [],
      }),
      precedents: async () => ({
        precedents: [
          {
            kind: 'ui-behavior',
            signature: 'ui-behavior:shared-fee-settings',
            score: 9,
            anchor: {
              name: 'CampaignFeeSettings',
              title: 'Shared donor tips / platform fees settings UI',
              kind: 'Function',
              filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
            },
            examples: [
              {
                name: 'AuctionSettings',
                kind: 'Function',
                filePath: 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx',
              },
            ],
          },
          {
            kind: 'backend-behavior',
            signature: 'backend-behavior:payment-config-quartet',
            score: 8,
            anchor: {
              name: 'PaddleRaiseResource',
              title: 'Fee or tips payment config quartet',
              kind: 'Class',
              filePath: 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php',
            },
            examples: [],
          },
        ],
      }),
      queryMode: async () => ({
        query_mode: {
          query_plan: { exact_lookup: { used: false, hits: 0 } },
          slices: [],
          processes: [],
          symbols: [],
          precedents: [],
        },
        _query_mode: {
          convergence: {
            enabled: false,
            source_path: null,
            matrix_cells: 0,
          },
        },
      }),
      getIndexStatus: async () => ({
        isStale: false,
        indexedAt: null,
        indexedCommit: null,
        headCommit: null,
        refreshCommandSandbox: null,
        refreshCommandSandboxForce: null,
      }),
      parsePathPrefixes: () => [],
      clampInteger,
      normalizeRepoRelativePath: value => String(value || '').replace(/^\.?\//, ''),
      toFiniteNumber,
    },
    repo,
    {
      query: 'Add Paddle Raise commitments dashboard settings using the same donor tips and platform fees UI and exact same options as campaign settings and auction settings',
      include_query_head: true,
      include_review_contract: true,
      limit_files: 10,
      limit_write_order: 10,
      limit_checks: 10,
      limit_precedents: 3,
    },
  );

  assert.equal(result.status, 'ok');
  assert.match(
    String(result.implement_mode?.target?.archetype || ''),
    /^direct-precedent:ui-behavior:Shared donor tips \/ platform fees settings UI$/,
  );
  assert.equal(
    result.implement_mode?.target?.reference_surface?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
  );
  assert.equal(
    result.implement_mode?.companion_files?.[0]?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
  );
  assert.equal(
    result.implement_mode?.write_plan?.[0]?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
  );
  assert.match(
    String(result.implement_mode?.next_actions?.[0] || ''),
    /calibrated precedent anchor "CampaignFeeSettings"/,
  );
  assert.ok(
    result.implement_mode?.companion_files?.some(file => file?.filePath === 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx'),
  );
  assert.ok(
    result.implement_mode?.companion_files?.some(file => file?.filePath === 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php'),
  );
  assert.equal(result._implement_mode?.direct_precedent_recovery?.target_calibrated, true);
  assert.equal(
    result._implement_mode?.direct_precedent_recovery?.top_file,
    'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
  );
  assert.ok(
    result.implement_mode?.quality?.reasons?.includes('planner target calibrated from direct precedents'),
  );
});
