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
  assert.ok(card.behaviorTags.includes('queue-assignment-notification'));
  assert.ok(card.behaviorTags.includes('delivery-mail-send'));
  assert.ok(card.behaviorTags.includes('delivery-notify'));
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
});
