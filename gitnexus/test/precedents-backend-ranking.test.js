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
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
      },
    );
  } catch (e) {
    const err = e;
    const stdout = (err?.stdout || '').toString();
    const stderr = (err?.stderr || '').toString();
    const status = err?.status ?? err?.code ?? 'unknown';
    throw new Error(
      [
        `analyze failed (status: ${status})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
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

const setupBackendMiningRepo = async (tmpRoot) => {
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Jobs/Campaign'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Mail'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Notifications'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Accounts'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Services/Engage/Mail/QRCode'), { recursive: true });
  await fs.mkdir(path.join(repoPath, '.agents/review'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Jobs/Campaign/QueuedInviteReminder.php'),
    [
      '<?php',
      '',
      'class QueuedInviteReminder extends Job',
      '{',
      '    public function __construct()',
      '    {',
      '        $this->onQueue(JobQueue::MAIL);',
      '    }',
      '',
      '    public function handle(): void',
      '    {',
      '        Mail::to($this->invite->email)->send(new InviteReminderMailable($this->invite));',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Mail/InviteReminderMailable.php'),
    [
      '<?php',
      '',
      'class InviteReminderMailable extends BaseMailable',
      '{',
      '    public function build()',
      '    {',
      '        return $this;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Notifications/InviteReminderNotification.php'),
    [
      '<?php',
      '',
      'class InviteReminderNotification extends BaseNotification',
      '{',
      '    public function toMail($notifiable)',
      '    {',
      '        return null;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Accounts/QrCodeController.php'),
    [
      '<?php',
      '',
      'class QrCodeController extends Controller',
      '{',
      '    public function __construct(private readonly QRCodeService $qrCodeService) {}',
      '',
      '    public function store(StoreQrCodeRequest $request, Account $account)',
      '    {',
      '        return response()->json([',
      "            'qr_code' => QrCodeResource::make($data['qr_code'])->setSvgContent($data['svg']),",
      "            'mail_piece' => MailPieceResource::make($data['mail_piece']),",
      '        ]);',
      '    }',
      '',
      '    public function update(UpdateQrCodeRequest $request, Account $account, QrCode $qrCode)',
      '    {',
      '        return QrCodeResource::make($data[\'qr_code\'])->setSvgContent($data[\'svg\']);',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/AccountController.php'),
    [
      '<?php',
      '',
      'class AccountController extends Controller',
      '{',
      '    public function campaignItemQRCode(Request $request)',
      '    {',
      "        $pdf = PDF::chunkLoadView('<mpdf-html-separator/>', 'campaigns.qr_auction_item', []);",
      '        return $pdf;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Services/Engage/Mail/QRCode/QRCodeParser.php'),
    [
      '<?php',
      '',
      'class QRCodeParser',
      '{',
      '    public function replaceQrCodes(?string $body, array $qrCodes): ?string',
      '    {',
      '        $svg = app(QRCodeService::class)->makeBase64Svg($qrCode->url, $qrCode->color, $qrCode->backgroundColor);',
      "        $image->setAttribute('src', $svg);",
      '        return $body;',
      '    }',
      '',
      '    public function removeQrCodesFromBody(?string $body): ?string',
      '    {',
      "        $div->parentNode->removeChild($div);",
      '        return $body;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, '.agents/review/pattern-catalog.md'),
    [
      '## Backend delivery and QR flows',
      '',
      '### Queued mail job owner',
      'Template:',
      '`apps/backend/app/Jobs/Campaign/QueuedInviteReminder.php`',
      'Notes:',
      '- Use when a queued Job owns delivery orchestration and picks its queue with onQueue(JobQueue::MAIL).',
      '',
      '### Queued mail owner',
      'Template:',
      '`apps/backend/app/Mail/InviteReminderMailable.php`',
      'Notes:',
      '- Use when queue ownership lives on BaseMailable or an inherited mail queue.',
      '',
      '### Queued notification owner',
      'Template:',
      '`apps/backend/app/Notifications/InviteReminderNotification.php`',
      'Notes:',
      '- Use when delivery ownership lives on BaseNotification and the notifications queue is inherited.',
      '',
      '### QR code CRUD resource with mail piece sidecar',
      'Template:',
      '`apps/backend/app/Http/Controllers/Dashboard/API/Accounts/QrCodeController.php`',
      'Notes:',
      '- Use when account QR code create or update returns qr_code plus optional mail_piece sidecar.',
      '',
      '### QR code inline PDF export',
      'Template:',
      '`apps/backend/app/Http/Controllers/Dashboard/AccountController.php`',
      'Notes:',
      '- Use when a web controller renders QR exports through PDF::chunkLoadView for inline download.',
      '',
      '### QR code HTML embed parser',
      'Template:',
      '`apps/backend/app/Services/Engage/Mail/QRCode/QRCodeParser.php`',
      'Notes:',
      '- Use when QR blocks in HTML are replaced with base64 SVG and removable qr-code fragments.',
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

test('precedents: boosts backend queued delivery and QR semantics', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-backend-'));
  const { repoPath, env } = await setupBackendMiningRepo(tmpRoot);

  const queuedJobResult = runTool('precedents', {
    repo: repoPath,
    query: 'queued email job ShouldQueue onQueue JobQueue mail end to end flow',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(queuedJobResult.status, 'ok');
  assert.ok(Array.isArray(queuedJobResult.precedents));
  assert.ok(queuedJobResult.precedents.length > 0);
  assert.equal(
    queuedJobResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Jobs/Campaign/QueuedInviteReminder.php',
  );
  assert.ok((queuedJobResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 3);

  const queuedMailOwnerResult = runTool('precedents', {
    repo: repoPath,
    query: 'BaseMailable inherited queue mail owner',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(queuedMailOwnerResult.status, 'ok');
  assert.equal(
    queuedMailOwnerResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Mail/InviteReminderMailable.php',
  );
  assert.ok((queuedMailOwnerResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);

  const qrCrudResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR code CRUD account message mail piece sidecar',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrCrudResult.status, 'ok');
  assert.equal(
    qrCrudResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Http/Controllers/Dashboard/API/Accounts/QrCodeController.php',
  );
  assert.ok((qrCrudResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);

  const qrExportResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR code pdf export inline download',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrExportResult.status, 'ok');
  assert.equal(
    qrExportResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Http/Controllers/Dashboard/AccountController.php',
  );
  assert.ok((qrExportResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 1);

  const qrParserResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR code parser html embed base64 svg',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrParserResult.status, 'ok');
  assert.equal(
    qrParserResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Services/Engage/Mail/QRCode/QRCodeParser.php',
  );
  assert.ok((qrParserResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);
  assert.ok(Array.isArray(qrParserResult.diagnostics?.backend_behavior_query_tags));
});
