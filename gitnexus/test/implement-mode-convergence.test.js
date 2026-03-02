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
