import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runActionPlan } from '../dist/mcp/local/action-plan.js';

const clampInteger = (value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const toOptionalNonNegativeInteger = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const normalized = Math.trunc(n);
  return normalized >= 0 ? normalized : undefined;
};

const toFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toOptionalLineNumber = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const normalized = Math.trunc(n);
  return normalized > 0 ? normalized : undefined;
};

const normalizeConfidence = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const parseStringList = (value) => {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
};

const normalizeSliceStencilTokens = (values) => parseStringList(values);
const round3 = (value) => Math.round(Number(value || 0) * 1000) / 1000;
const normalizeRepoRelativePath = (value) => String(value || '').trim().replace(/^\.\/+/, '').replace(/\\/g, '/');

test('runActionPlan calibrates files and write order from direct settings precedents when target slice is generic', async () => {
  const repo = {
    id: 'monorepo',
    name: 'monorepo',
    repoPath: '/Users/benny/monorepo',
    storagePath: '/tmp/gitnexus-test-storage',
  };

  const queryResult = {
    query_plan: {
      intent: 'concept',
    },
    slice_cards: [
      {
        uid: 'FeatureSlice:slice_permission_paddle_raise_view',
        label: 'Permission Slice: paddle_raise.view',
        slice_type: 'permission',
        anchor_id: 'CodeElement:permission:paddle_raise.view',
        anchor_name: 'paddle_raise.view',
        closure_score: 1,
        closure_slots: ['anchor', 'authorization_consumer'],
        closed_slots: ['anchor', 'authorization_consumer'],
        roles: ['anchor', 'authorization_consumer'],
        matched_members: [
          {
            uid: 'permission-member',
            name: 'PaddleRaisePermission',
            filePath: 'apps/backend/app/Domains/AccessControl/Permissions/PaddleRaisePermission.php',
          },
        ],
      },
    ],
    processes: [
      {
        id: 'proc-paddle-raise-permission',
        summary: 'Paddle Raise permission flow',
        process_type: 'cross_community',
      },
    ],
    process_symbols: [
      {
        id: 'permission-symbol',
        filePath: 'apps/backend/app/Domains/AccessControl/Permissions/PaddleRaisePermission.php',
        name: 'PaddleRaisePermission',
        type: 'Enum',
        step_index: 0,
        hit_rank: 1,
      },
      {
        id: 'campaigns-api-symbol',
        filePath: 'apps/dashboard/src/api/campaigns.ts',
        name: 'fetchPaddleRaiseIntent',
        type: 'Function',
        step_index: 1,
        hit_rank: 2,
      },
    ],
    definitions: [],
  };

  const precedentCalls = [];
  const precedentResult = {
    precedents: [
      {
        kind: 'ui-behavior',
        signature: 'settings:shared-tips-fees',
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
        anchor: {
          title: 'Fee or tips payment config quartet',
          filePath: 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php',
        },
      },
    ],
  };

  const plan = await runActionPlan(
    {
      query: async () => queryResult,
      precedents: async (_repo, params) => {
        precedentCalls.push(params);
        return precedentResult;
      },
      executeQuery: async () => [],
      loadClosureTemplateSnapshot: async () => ({ templates: [] }),
      parsePathPrefixes: () => [],
      filePathTouchesPrefixes: () => true,
      clampInteger,
      toOptionalNonNegativeInteger,
      toFiniteNumber,
      toOptionalLineNumber,
      normalizeConfidence,
      parseStringList,
      normalizeSliceStencilTokens,
      round3,
      normalizeRepoRelativePath,
      resolvePathInsideRepo: () => null,
    },
    repo,
    {
      query: 'Add Paddle Raise commitments dashboard settings using the same donor tips and platform fees UI and exact same options as campaign settings and auction settings',
    },
  );

  assert.equal(plan.status, 'ok');
  assert.equal(precedentCalls.length, 1);
  assert.equal(precedentCalls[0]?.anchor_uid, undefined);
  assert.equal(plan.implement_plan?.target?.target_calibrated_from_precedents, true);
  assert.equal(
    plan.implement_plan?.target?.direct_precedent_anchor?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx',
  );
  assert.match(String(plan.implement_plan?.target?.archetype || ''), /^direct-precedent:/);
  assert.equal(plan.files?.[0]?.filePath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx');
  assert.ok(
    plan.files.slice(0, 3).some((file) => file?.filePath === 'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx'),
    'expected CampaignFeeSettings.tsx in recovered top files',
  );
  assert.ok(
    plan.files.slice(0, 3).some((file) => file?.filePath === 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php'),
    'expected PaddleRaiseResource.php in recovered top files',
  );
  assert.equal(plan.implement_plan?.companion_set?.files?.[0]?.filePath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx');
  assert.equal(plan.implement_plan?.write_order?.[0]?.filePath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx');
  assert.equal(plan._action_plan?.direct_precedent_recovery?.target_calibrated, true);
  assert.equal(plan._action_plan?.direct_precedent_recovery?.target_slice_looks_generic, true);
});
