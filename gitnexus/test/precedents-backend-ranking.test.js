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

  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Console/Commands'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Console/Commands/Engage/MessageDeliveries'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Jobs/Campaign'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Jobs/Export'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Jobs/Transaction'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Mail'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Notifications'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Accounts'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Webhooks'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Domains/Reporting/Scheduling/Processing'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Services/Engage/Mail/QRCode'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Services/Engage/Mail/Providers/Lob'), { recursive: true });
  await fs.mkdir(path.join(repoPath, '.agents/review'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Console/Kernel.php'),
    [
      '<?php',
      '',
      'class Kernel extends ConsoleKernel',
      '{',
      '    protected function schedule(Schedule $schedule): void',
      '    {',
      '        $schedule->job(QueuedInviteReminder::class);',
      '        $schedule->command(ProcessDueAccountReportSchedulesCommand::class);',
      '        $schedule->command(CreateEmailDeliveries::class);',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Console/Commands/BackfillPayoutFingerprints.php'),
    [
      '<?php',
      '',
      'class BackfillPayoutFingerprints extends Command',
      '{',
      '    public function handle(): int',
      '    {',
      "        $batch = Bus::batch($jobs)->name('Backfill Payout Fingerprints')->onQueue('backfill')->dispatch();",
      '        return self::SUCCESS;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php'),
    [
      '<?php',
      '',
      'class CreateEmailDeliveries extends CreateMessageDeliveries',
      '{',
      '    protected function getJobChain(Message $message): PendingChain',
      '    {',
      '        return Bus::chain([',
      '            new VerifyEngageDomain($message),',
      '            new PrepareEngageMessage($message),',
      '        ])->onQueue(JobQueue::ENGAGE);',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

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
    path.join(repoPath, 'apps/backend/app/Jobs/Export/BulkGenerateEOYSummaryExports.php'),
    [
      '<?php',
      '',
      'class BulkGenerateEOYSummaryExports extends Job',
      '{',
      '    public function __construct(public Export $export) {}',
      '',
      '    public function handle(): void',
      '    {',
      '        $batch = Bus::batch($jobs)',
      '            ->name("BulkGenerateEOYSummaryExports - Export #{$this->export->id}")',
      '            ->finally(function () {',
      '                Mail::to($this->export->creator->email)->send(new EOYExportSent($this->export, 1));',
      '            })',
      '            ->dispatch();',
      '',
      "        $this->export->forceFill(['metadata->job_tracking_id' => $batch->id])->save();",
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Jobs/Transaction/SendTransactionNotifications.php'),
    [
      '<?php',
      '',
      'class SendTransactionNotifications extends Job',
      '{',
      '    public function __construct()',
      '    {',
      '        $this->onQueue(JobQueue::APPLICATION);',
      '    }',
      '',
      '    public function handle(): void',
      '    {',
      '        Mail::to($email)->send(new TransactionSucceededMailable($transaction));',
      '        Notification::send($admins, new $adminNotifClass($transaction, $role));',
      '        $user->notify(new $teamNotifClass($transaction, $role));',
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
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Webhooks/LobController.php'),
    [
      '<?php',
      '',
      'class LobController extends Controller',
      '{',
      '    public function handle(Request $request)',
      '    {',
      '        HandleLobWebhookJob::dispatch($request->all(), $request->getContent(), $request->header());',
      "        return response()->json(['ok' => true]);",
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Domains/Reporting/Scheduling/Processing/ProcessDueAccountReportSchedulesCommand.php'),
    [
      '<?php',
      '',
      'class ProcessDueAccountReportSchedulesCommand extends Command',
      '{',
      '    public function handle(): int',
      '    {',
      '        dispatch(new QueuedInviteReminder());',
      '        return self::SUCCESS;',
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
    path.join(repoPath, 'apps/backend/app/Http/Controllers/QrCodeRedirectController.php'),
    [
      '<?php',
      '',
      'class QrCodeRedirectController extends Controller',
      '{',
      '    public function __invoke(Request $request, QrCode $qrCode): RedirectResponse',
      '    {',
      '        $destinationUrl = $qrCode->getDestinationUrl($traceId);',
      '        $qrCode->markAsScanned($destinationUrl, null, null, null);',
      '        return redirect()->away($destinationUrl);',
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
    path.join(repoPath, 'apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php'),
    [
      '<?php',
      '',
      'class LobLetterPdfBuilder',
      '{',
      '    public function __construct(private readonly QRCodeParser $qrCodeParser) {}',
      '',
      '    private function processQrCodes(MailPiece $mailPiece): string',
      '    {',
      '        $redirectUrl = $qrCode->getRedirectUrl([\'gbtid\' => (string) $tracer->trace_id]);',
      '        return $this->qrCodeParser->replaceQrCodes($body, $qrCodes);',
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
      '### Scheduled queued job in kernel',
      'Template:',
      '`apps/backend/app/Console/Kernel.php`',
      'Notes:',
      '- Use when Console Kernel is the ingress and schedule->job / schedule->command selects the queued work family.',
      '',
      '### Console command batch dispatcher',
      'Template:',
      '`apps/backend/app/Console/Commands/BackfillPayoutFingerprints.php`',
      'Notes:',
      '- Use when a console command assembles child work with Bus::batch and dispatches it onto a queue.',
      '',
      '### Console command chain queue owner',
      'Template:',
      '`apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php`',
      'Notes:',
      '- Use when a console command owns a Bus::chain queue selection and stages downstream email work.',
      '',
      '### Webhook dispatch callsite',
      'Template:',
      '`apps/backend/app/Http/Controllers/Webhooks/LobController.php`',
      'Notes:',
      '- Use when a webhook controller acknowledges immediately and kicks off queued work via dispatch.',
      '',
      '### Queued job batch with mail delivery',
      'Template:',
      '`apps/backend/app/Jobs/Export/BulkGenerateEOYSummaryExports.php`',
      'Notes:',
      '- Use when a queued job batches child work and owns the completion email inside the batch callback.',
      '',
      '### Queued job notification selector',
      'Template:',
      '`apps/backend/app/Jobs/Transaction/SendTransactionNotifications.php`',
      'Notes:',
      '- Use when a queued job chooses concrete mailables and notifications inside the job handle path.',
      '',
      '### QR code CRUD resource with mail piece sidecar',
      'Template:',
      '`apps/backend/app/Http/Controllers/Dashboard/API/Accounts/QrCodeController.php`',
      'Notes:',
      '- Use when account QR code create or update returns qr_code plus optional mail_piece sidecar.',
      '',
      '### QR redirect entrypoint',
      'Template:',
      '`apps/backend/app/Http/Controllers/QrCodeRedirectController.php`',
      'Notes:',
      '- Use when scanned QR requests resolve destination URLs, mark scans, and redirect away.',
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
      '### QR mail piece handoff',
      'Template:',
      '`apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php`',
      'Notes:',
      '- Use when outbound mail-piece generation swaps QR placeholders for trackable redirect links before delivery.',
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

  const queuedNotificationOwnerResult = runTool('precedents', {
    repo: repoPath,
    query: 'BaseNotification inherited queue notification owner',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(queuedNotificationOwnerResult.status, 'ok');
  assert.equal(
    queuedNotificationOwnerResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Notifications/InviteReminderNotification.php',
  );
  assert.ok((queuedNotificationOwnerResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);

  const kernelResult = runTool('precedents', {
    repo: repoPath,
    query: 'kernel schedule cron queued job command flow',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(kernelResult.status, 'ok');
  assert.equal(
    kernelResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Console/Kernel.php',
  );
  assert.ok((kernelResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);

  const kernelScheduledCommandHandoffResult = runTool('precedents', {
    repo: repoPath,
    query: 'kernel schedule create email deliveries command scheduled',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(kernelScheduledCommandHandoffResult.status, 'ok');
  assert.equal(
    kernelScheduledCommandHandoffResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Console/Kernel.php',
  );
  assert.equal(kernelScheduledCommandHandoffResult.precedents[0]?.kind, 'backend-handoff');
  assert.ok((kernelScheduledCommandHandoffResult.precedents[0]?.ranking?.components?.backend_handoff_matches || 0) >= 2);
  assert.ok(
    kernelScheduledCommandHandoffResult.precedents.slice(0, 3).some(precedent => (
      precedent?.anchor?.filePath === 'apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php'
      || precedent?.member_files?.includes('apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php')
      || precedent?.examples?.some?.((example) => example?.filePath === 'apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php')
    )),
  );

  const commandBatchResult = runTool('precedents', {
    repo: repoPath,
    query: 'console command batch dispatch queue flow',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(commandBatchResult.status, 'ok');
  assert.equal(
    commandBatchResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Console/Commands/BackfillPayoutFingerprints.php',
  );
  assert.ok((commandBatchResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);
  assert.ok((commandBatchResult.precedents[0]?.ranking?.components?.backend_context_bonus || 0) > 0);

  const commandChainResult = runTool('precedents', {
    repo: repoPath,
    query: 'console command chain-level onQueue queued email flow',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(commandChainResult.status, 'ok');
  assert.equal(
    commandChainResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php',
  );
  assert.ok((commandChainResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 3);
  assert.ok((commandChainResult.precedents[0]?.ranking?.components?.backend_context_bonus || 0) > 0);

  const webhookDispatchResult = runTool('precedents', {
    repo: repoPath,
    query: 'webhook controller dispatch queued job',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(webhookDispatchResult.status, 'ok');
  assert.equal(
    webhookDispatchResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Http/Controllers/Webhooks/LobController.php',
  );
  assert.ok((webhookDispatchResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 2);

  const jobBatchMailResult = runTool('precedents', {
    repo: repoPath,
    query: 'queued job batch mail end to end flow',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(jobBatchMailResult.status, 'ok');
  assert.equal(
    jobBatchMailResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Jobs/Export/BulkGenerateEOYSummaryExports.php',
  );
  assert.ok((jobBatchMailResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 3);

  const notificationSelectorResult = runTool('precedents', {
    repo: repoPath,
    query: 'queued job notification selector notify admins notify user mail selector',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(notificationSelectorResult.status, 'ok');
  assert.equal(
    notificationSelectorResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Jobs/Transaction/SendTransactionNotifications.php',
  );
  assert.ok((notificationSelectorResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 3);

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

  const qrRedirectResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR redirect scan destination trackable entrypoint',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrRedirectResult.status, 'ok');
  assert.equal(
    qrRedirectResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Http/Controllers/QrCodeRedirectController.php',
  );
  assert.ok((qrRedirectResult.precedents[0]?.ranking?.components?.backend_behavior_matches || 0) >= 1);

  const qrRedirectOutboundHandoffResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR redirect outbound handoff direct mail',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrRedirectOutboundHandoffResult.status, 'ok');
  assert.equal(
    qrRedirectOutboundHandoffResult.precedents[0]?.anchor?.filePath,
    'apps/backend/app/Http/Controllers/QrCodeRedirectController.php',
  );
  assert.equal(qrRedirectOutboundHandoffResult.precedents[0]?.kind, 'backend-handoff');
  assert.ok((qrRedirectOutboundHandoffResult.precedents[0]?.ranking?.components?.backend_handoff_matches || 0) >= 2);
  assert.ok(
    qrRedirectOutboundHandoffResult.precedents[0]?.member_files?.includes(
      'apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php',
    ),
  );
  assert.ok(
    qrRedirectOutboundHandoffResult.precedents[0]?.backend_handoff?.reasons?.some?.((reason) => (
      String(reason || '').startsWith('laravel-qr-delivery-')
    )),
  );

  const qrMailPieceHandoffResult = runTool('precedents', {
    repo: repoPath,
    query: 'QR mail piece outbound handoff letter pdf builder lob',
    limit: 10,
    examples: 3,
  }, env);

  assert.equal(qrMailPieceHandoffResult.status, 'ok');
  assert.ok(
    qrMailPieceHandoffResult.precedents.slice(0, 3).some(precedent => (
      precedent?.anchor?.filePath === 'apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php'
      || precedent?.member_files?.includes('apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php')
      || precedent?.examples?.some?.((example) => example?.filePath === 'apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php')
    )),
  );
});
