import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, env) => {
  return execFileSync(
    'node',
    [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    },
  );
};

const runTool = (method, params, env) => {
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'await backend.init();',
    `const result = await backend.callTool(${JSON.stringify(method)}, ${JSON.stringify(params)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return JSON.parse(raw);
};

const setupSettingsRepo = async tmpRoot => {
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages/campaign-settings/campaign-settings'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages/pledges'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Mobile'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Handlers/Checkout'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Requests/Pledges'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Resources/Dashboard/Pledges'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/ViewModels'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx'),
    [
      "import { TipsAndFeesDescription } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesDescription';",
      "import { TipsAndFeesRadioButtons } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesRadioButtons';",
      "import { TipsAndFeesSettingsProvider } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesSettingsContext';",
      "import { getTipFeesSettingCodesFromValues } from 'pages/campaign-settings/campaign-settings/tips-and-fees/util';",
      '',
      'export const CampaignFeeSettings = () => {',
      '  const settings = getTipFeesSettingCodesFromValues(values);',
      '  return (',
      '    <TipsAndFeesSettingsProvider isAuction={false}>',
      '      <TipsAndFeesDescription />',
      '      <TipsAndFeesRadioButtons />',
      '    </TipsAndFeesSettingsProvider>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx'),
    [
      "import { TipsAndFeesDescription } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesDescription';",
      "import { TipsAndFeesRadioButtons } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesRadioButtons';",
      "import { TipsAndFeesSettingsProvider } from 'pages/campaign-settings/campaign-settings/tips-and-fees/TipsAndFeesSettingsContext';",
      '',
      'export const AuctionSettings = () => {',
      '  return (',
      '    <TipsAndFeesSettingsProvider isAuction={true}>',
      '      <TipsAndFeesDescription />',
      '      <TipsAndFeesRadioButtons />',
      '    </TipsAndFeesSettingsProvider>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/pledges/PledgeSettingsForm.tsx'),
    [
      'export const PledgeSettingsForm = () => {',
      "  const keys = ['fee_coverage_visibility', 'fee_coverage_type', 'tips_enabled'];",
      '  return keys.join(show_fees + show_tips + edit_fees);',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php'),
    [
      '<?php',
      '',
      'class PaddleRaiseResource',
      '{',
      '    public function toArray(): array',
      '    {',
      '        return [',
      "            'show_fees' => true,",
      "            'show_tips' => $campaign->hasTipsEnabled(),",
      "            'edit_fees' => ! $campaign->requiresCoveringFees(),",
      "            'fee_coverage_type' => PledgeFeeCoverageTypeEnum::ALL,",
      '        ];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Mobile/FeeController.php'),
    [
      '<?php',
      '',
      'class FeeController',
      '{',
      '    public function __invoke(): array',
      '    {',
      '        return (new DonationHandler())->fees();',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Handlers/Checkout/DonationHandler.php'),
    [
      '<?php',
      '',
      'class DonationHandler',
      '{',
      '    public function fees(): array',
      '    {',
      "        return ['cover_fees' => true, 'platform_fees' => true];",
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/routes/mobile.php'),
    [
      '<?php',
      '',
      "Route::post('/api-mobile/donate/fees', FeeController::class);",
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/ViewModels/PledgePageViewModel.php'),
    [
      '<?php',
      '',
      'class PledgePageViewModel',
      '{',
      '    public function pledgeConfigData()',
      '    {',
      '        return [',
      "            'show_fees' => $this->pledge->tips_enabled || $showFees,",
      "            'show_tips' => $this->pledge->tips_enabled,",
      "            'edit_fees' => $this->pledge->tips_enabled || $editFees,",
      "            'fee_coverage_type' => $this->pledge->fee_coverage_type,",
      "            'fee_coverage_visibility' => $this->pledge->fee_coverage_visibility,",
      '        ];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Requests/Pledges/PledgeStoreRequest.php'),
    [
      '<?php',
      '',
      'class PledgeStoreRequest',
      '{',
      '    public function rules(): array',
      '    {',
      '        return [',
      "            'fee_coverage_visibility' => ['required'],",
      "            'fee_coverage_type' => ['required'],",
      "            'tips_enabled' => ['boolean'],",
      '        ];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Requests/Pledges/PledgeUpdateRequest.php'),
    [
      '<?php',
      '',
      'class PledgeUpdateRequest',
      '{',
      '    public function rules(): array',
      '    {',
      '        return [',
      "            'fee_coverage_visibility' => ['required'],",
      "            'fee_coverage_type' => ['required'],",
      "            'tips_enabled' => ['boolean'],",
      '        ];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Resources/Dashboard/Pledges/PledgeResource.php'),
    [
      '<?php',
      '',
      'class PledgeResource',
      '{',
      '    public function toArray(): array',
      '    {',
      '        return [',
      "            'fee_coverage_visibility' => $this->pledge->fee_coverage_visibility,",
      "            'fee_coverage_type' => $this->pledge->fee_coverage_type,",
      "            'tips_enabled' => $this->pledge->tips_enabled,",
      '        ];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['branch', '-M', 'main']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully/i);

  return { repoPath, env };
};

test('precedents: surfaces fee or tips settings hotspot cards', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-settings-'));
  const { repoPath, env } = await setupSettingsRepo(tmpRoot);

  const sharedSettingsResult = runTool('precedents', {
    repo: repoPath,
    query: 'campaign settings donor tips platform fees cover fees absorb fees',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(sharedSettingsResult.status, 'ok');
  assert.equal(sharedSettingsResult.precedents[0]?.kind, 'ui-behavior');
  assert.equal(
    sharedSettingsResult.precedents[0]?.anchor?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-settings/CampaignFeeSettings.tsx',
  );

  const auctionSettingsResult = runTool('precedents', {
    repo: repoPath,
    query: 'auction settings donor tips platform fees cover fees auto charge optional donor tips',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(auctionSettingsResult.status, 'ok');
  assert.equal(auctionSettingsResult.precedents[0]?.kind, 'ui-behavior');
  assert.equal(
    auctionSettingsResult.precedents[0]?.anchor?.filePath,
    'apps/dashboard/src/pages/campaign-settings/campaign-auction/auction-settings/AuctionSettings.tsx',
  );

  const pledgeSettingsResult = runTool('precedents', {
    repo: repoPath,
    query: 'pledge fee coverage visibility require fees hide fees',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(pledgeSettingsResult.status, 'ok');
  assert.ok(
    pledgeSettingsResult.precedents
      .slice(0, 5)
      .some(precedent => precedent?.kind === 'ui-behavior'
        && precedent?.anchor?.filePath === 'apps/dashboard/src/pages/pledges/PledgeSettingsForm.tsx'),
  );

  const pledgeDashboardSettingsResult = runTool('precedents', {
    repo: repoPath,
    query: 'pledge settings fee coverage visibility require fees hide fees',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(pledgeDashboardSettingsResult.status, 'ok');
  assert.equal(pledgeDashboardSettingsResult.precedents[0]?.kind, 'ui-behavior');
  assert.equal(
    pledgeDashboardSettingsResult.precedents[0]?.anchor?.filePath,
    'apps/dashboard/src/pages/pledges/PledgeSettingsForm.tsx',
  );

  const quartetResult = runTool('precedents', {
    repo: repoPath,
    query: 'paddle raise show_fees show_tips edit_fees fee_coverage_type payment config',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(quartetResult.status, 'ok');
  assert.equal(quartetResult.precedents[0]?.kind, 'backend-behavior');
  assert.equal(
    quartetResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Domains/PaddleRaise/Http/Web/Resources/PaddleRaiseResource.php',
  );
});
