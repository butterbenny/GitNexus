import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPhpBehaviorCard } from '../dist/core/derived/php-behavior.js';

test('php-behavior: derives queued job delivery ownership signals', async () => {
  const content = [
    '<?php',
    '',
    'class SendEventReminders extends Job',
    '{',
    '    public function __construct()',
    '    {',
    '        $this->onQueue(JobQueue::NOTIFICATION);',
    '    }',
    '',
    '    public function handle(): void',
    '    {',
    '        Mail::to($email)->send(new EventReminderMailable($event, $tickets));',
    '        $user->notify(new ReminderNotification());',
    '    }',
    '}',
    '',
  ].join('\n');

  const card = await extractPhpBehaviorCard(
    'apps/backend/app/Jobs/Event/SendEventReminders.php',
    content,
  );

  assert.ok(card.behaviorTags.includes('queued-job-owner'));
  assert.ok(card.behaviorTags.includes('queue-assignment-explicit'));
  assert.ok(card.behaviorTags.includes('queue-assignment-job'));
  assert.ok(card.behaviorTags.includes('queue-assignment-notification'));
  assert.ok(card.behaviorTags.includes('delivery-mail-send'));
  assert.ok(card.behaviorTags.includes('delivery-notify'));
  assert.ok(card.behaviorTags.includes('delivery-selector-mail'));
  assert.ok(card.behaviorTags.includes('delivery-selector-notification'));
  assert.ok(card.behaviorTags.includes('job-orchestrates-mail-delivery'));
  assert.ok(card.behaviorTags.includes('job-orchestrates-notification-delivery'));
});

test('php-behavior: derives inherited queued mail owner signals', async () => {
  const content = [
    '<?php',
    '',
    'class PaymentRequestMailable extends BaseMailable',
    '{',
    '    public function build()',
    '    {',
    '        return $this;',
    '    }',
    '}',
    '',
  ].join('\n');

  const card = await extractPhpBehaviorCard(
    'apps/backend/app/Mail/PaymentRequestMailable.php',
    content,
  );

  assert.ok(card.behaviorTags.includes('queued-mail-owner'));
  assert.ok(card.behaviorTags.includes('queue-assignment-inherited'));
  assert.ok(card.behaviorTags.includes('queue-assignment-mail'));
});

test('php-behavior: derives scheduler and dispatch orchestration signals', async () => {
  const kernelContent = [
    '<?php',
    '',
    'class Kernel extends ConsoleKernel',
    '{',
    '    protected function schedule(Schedule $schedule): void',
    '    {',
    '        $schedule->job(SendEventReminders::class);',
    '        $schedule->command(ProcessDueAccountReportSchedulesCommand::class);',
    '    }',
    '}',
    '',
  ].join('\n');

  const kernelCard = await extractPhpBehaviorCard(
    'apps/backend/app/Console/Kernel.php',
    kernelContent,
  );

  assert.ok(kernelCard.behaviorTags.includes('scheduler-kernel-owner'));
  assert.ok(kernelCard.behaviorTags.includes('scheduler-schedules-job'));
  assert.ok(kernelCard.behaviorTags.includes('scheduler-schedules-command'));

  const commandContent = [
    '<?php',
    '',
    'class BackfillPayoutFingerprints extends Command',
    '{',
    '    public function handle(): int',
    '    {',
    "        Bus::batch($jobs)->onQueue('backfill')->dispatch();",
    '        dispatch(new ProcessAccountReportSchedule($schedule));',
    '        return self::SUCCESS;',
    '    }',
    '}',
    '',
  ].join('\n');

  const commandCard = await extractPhpBehaviorCard(
    'apps/backend/app/Console/Commands/BackfillPayoutFingerprints.php',
    commandContent,
  );

  assert.ok(commandCard.behaviorTags.includes('console-command-owner'));
  assert.ok(commandCard.behaviorTags.includes('command-dispatch-callsite'));
  assert.ok(commandCard.behaviorTags.includes('dispatch-batch-orchestrator'));
  assert.ok(commandCard.behaviorTags.includes('queue-assignment-batch'));

  const chainCommandContent = [
    '<?php',
    '',
    'class CreateEmailDeliveries extends CreateMessageDeliveries',
    '{',
    '    protected function getJobChain(Message $message): PendingChain',
    '    {',
    '        return Bus::chain([$job])->onQueue(JobQueue::ENGAGE);',
    '    }',
    '}',
    '',
  ].join('\n');

  const chainCommandCard = await extractPhpBehaviorCard(
    'apps/backend/app/Console/Commands/Engage/MessageDeliveries/CreateEmailDeliveries.php',
    chainCommandContent,
  );

  assert.ok(chainCommandCard.behaviorTags.includes('console-command-owner'));
  assert.ok(chainCommandCard.behaviorTags.includes('command-dispatch-callsite'));
  assert.ok(chainCommandCard.behaviorTags.includes('dispatch-chain-orchestrator'));
  assert.ok(chainCommandCard.behaviorTags.includes('queue-assignment-chain'));

  const webhookContent = [
    '<?php',
    '',
    'class LobController extends Controller',
    '{',
    '    public function handle(Request $request)',
    '    {',
    '        HandleLobWebhookJob::dispatch($request->all());',
    '    }',
    '}',
    '',
  ].join('\n');

  const webhookCard = await extractPhpBehaviorCard(
    'apps/backend/app/Http/Controllers/Webhooks/LobController.php',
    webhookContent,
  );

  assert.ok(webhookCard.behaviorTags.includes('controller-dispatch-callsite'));
  assert.ok(webhookCard.behaviorTags.includes('webhook-dispatch-callsite'));

  const orchestratorContent = [
    '<?php',
    '',
    'class BulkGenerateEOYSummaryExports extends Job',
    '{',
    '    public function __construct()',
    '    {',
    '        $this->onQueue(JobQueue::EXPORTS);',
    '    }',
    '',
    '    public function handle(): void',
    '    {',
    '        Bus::batch($jobs)->finally(function () use ($export) {',
    '            Mail::to($export->creator->email)->send(new EOYExportSent($export, $count));',
    '        })->dispatch();',
    '        Bus::chain([$job])->dispatch();',
    '    }',
    '}',
    '',
  ].join('\n');

  const orchestratorCard = await extractPhpBehaviorCard(
    'apps/backend/app/Jobs/Export/BulkGenerateEOYSummaryExports.php',
    orchestratorContent,
  );

  assert.ok(orchestratorCard.behaviorTags.includes('queued-job-owner'));
  assert.ok(orchestratorCard.behaviorTags.includes('queued-job-dispatch-callsite'));
  assert.ok(orchestratorCard.behaviorTags.includes('dispatch-batch-orchestrator'));
  assert.ok(orchestratorCard.behaviorTags.includes('dispatch-chain-orchestrator'));
  assert.ok(orchestratorCard.behaviorTags.includes('job-orchestrates-mail-delivery'));
  assert.ok(orchestratorCard.behaviorTags.includes('delivery-selector-mail'));
  assert.ok(orchestratorCard.behaviorTags.includes('queue-assignment-job'));
});

test('php-behavior: derives qr CRUD, export, and parser signals', async () => {
  const controllerContent = [
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
  ].join('\n');

  const controllerCard = await extractPhpBehaviorCard(
    'apps/backend/app/Http/Controllers/Dashboard/API/Accounts/QrCodeController.php',
    controllerContent,
  );

  assert.ok(controllerCard.behaviorTags.includes('qr-crud-resource'));
  assert.ok(controllerCard.behaviorTags.includes('qr-crud-mail-piece-sidecar'));
  assert.ok(controllerCard.behaviorTags.includes('qr-svg-generation'));

  const exportContent = [
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
  ].join('\n');

  const exportCard = await extractPhpBehaviorCard(
    'apps/backend/app/Http/Controllers/Dashboard/AccountController.php',
    exportContent,
  );

  assert.ok(exportCard.behaviorTags.includes('qr-export-inline-pdf'));

  const parserContent = [
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
  ].join('\n');

  const parserCard = await extractPhpBehaviorCard(
    'apps/backend/app/Services/Engage/Mail/QRCode/QRCodeParser.php',
    parserContent,
  );

  assert.ok(parserCard.behaviorTags.includes('qr-html-embed'));
  assert.ok(parserCard.behaviorTags.includes('qr-html-strip'));
  assert.ok(parserCard.behaviorTags.includes('qr-svg-generation'));

  const redirectContent = [
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
  ].join('\n');

  const redirectCard = await extractPhpBehaviorCard(
    'apps/backend/app/Http/Controllers/QrCodeRedirectController.php',
    redirectContent,
  );

  assert.ok(redirectCard.behaviorTags.includes('qr-redirect-entrypoint'));

  const handoffContent = [
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
  ].join('\n');

  const handoffCard = await extractPhpBehaviorCard(
    'apps/backend/app/Services/Engage/Mail/Providers/Lob/LobLetterPdfBuilder.php',
    handoffContent,
  );

  assert.ok(handoffCard.behaviorTags.includes('qr-trackable-redirect-link'));
  assert.ok(handoffCard.behaviorTags.includes('qr-mail-piece-handoff'));
});
