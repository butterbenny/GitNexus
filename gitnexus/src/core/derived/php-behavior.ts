export type PhpBehaviorTag =
  | 'scheduler-kernel-owner'
  | 'scheduler-schedules-job'
  | 'scheduler-schedules-command'
  | 'console-command-owner'
  | 'queued-job-owner'
  | 'queued-mail-owner'
  | 'queued-notification-owner'
  | 'command-dispatch-callsite'
  | 'controller-dispatch-callsite'
  | 'webhook-dispatch-callsite'
  | 'listener-dispatch-callsite'
  | 'queued-job-dispatch-callsite'
  | 'dispatch-callsite-sync'
  | 'dispatch-batch-orchestrator'
  | 'dispatch-chain-orchestrator'
  | 'queue-assignment-explicit'
  | 'queue-assignment-job'
  | 'queue-assignment-batch'
  | 'queue-assignment-chain'
  | 'queue-assignment-inherited'
  | 'queue-assignment-mail'
  | 'queue-assignment-notification'
  | 'delivery-mail-send'
  | 'delivery-mail-queue'
  | 'delivery-notify'
  | 'delivery-notification-send'
  | 'delivery-selector-mail'
  | 'delivery-selector-notification'
  | 'job-orchestrates-mail-delivery'
  | 'job-orchestrates-notification-delivery'
  | 'qr-crud-resource'
  | 'qr-crud-mail-piece-sidecar'
  | 'qr-export-inline-pdf'
  | 'qr-redirect-entrypoint'
  | 'qr-trackable-redirect-link'
  | 'qr-mail-piece-handoff'
  | 'qr-html-embed'
  | 'qr-html-strip'
  | 'qr-svg-generation';

export type PhpBehaviorSmell = {
  kind: string;
  message: string;
  line: number;
  confidence: number;
};

export type PhpQueueAssignment = {
  queue: string;
  via: 'onQueue' | 'property';
  explicit: boolean;
  line: number;
  confidence: number;
};

export type PhpDeliveryEffectKind =
  | 'mail-send'
  | 'mail-queue'
  | 'notify'
  | 'notification-send';

export type PhpDeliveryEffect = {
  kind: PhpDeliveryEffectKind;
  line: number;
  confidence: number;
};

export type PhpQrSignalKind =
  | 'qr-crud-resource'
  | 'qr-crud-mail-piece-sidecar'
  | 'qr-export-inline-pdf'
  | 'qr-redirect-entrypoint'
  | 'qr-trackable-redirect-link'
  | 'qr-mail-piece-handoff'
  | 'qr-html-embed'
  | 'qr-html-strip'
  | 'qr-svg-generation';

export type PhpQrSignal = {
  kind: PhpQrSignalKind;
  line: number;
  confidence: number;
};

export type PhpBehaviorCard = {
  filePath: string;
  behaviorTags: PhpBehaviorTag[];
  queueAssignments: PhpQueueAssignment[];
  deliveryEffects: PhpDeliveryEffect[];
  qrSignals: PhpQrSignal[];
  smells: PhpBehaviorSmell[];
};

const EMPTY_CARD = (filePath: string): PhpBehaviorCard => ({
  filePath,
  behaviorTags: [],
  queueAssignments: [],
  deliveryEffects: [],
  qrSignals: [],
  smells: [],
});

const ensureGlobalRegex = (pattern: RegExp): RegExp => {
  return pattern.flags.includes('g')
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
};

const toLineNumber = (content: string, index: number): number => {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
};

const collectMatches = (content: string, pattern: RegExp): RegExpExecArray[] => {
  const matches: RegExpExecArray[] = [];
  const regex = ensureGlobalRegex(pattern);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match);
    if (!match[0]) {
      regex.lastIndex += 1;
    }
  }
  return matches;
};

const findFirstLine = (content: string, pattern: RegExp): number => {
  const match = pattern.exec(content);
  return match?.index != null ? toLineNumber(content, match.index) : 1;
};

const isMailQueueName = (queue: string): boolean => {
  return /(mail|engage-email)/.test(String(queue || '').toLowerCase());
};

const isNotificationQueueName = (queue: string): boolean => {
  return /notification/.test(String(queue || '').toLowerCase());
};

const addTag = (target: Set<PhpBehaviorTag>, tag: PhpBehaviorTag): void => {
  target.add(tag);
};

const addQrSignal = (
  target: PhpQrSignal[],
  kind: PhpQrSignalKind,
  line: number,
  confidence = 0.9,
): void => {
  if (target.some(signal => signal.kind === kind)) return;
  target.push({ kind, line, confidence });
};

const addDeliveryEffect = (
  target: PhpDeliveryEffect[],
  kind: PhpDeliveryEffectKind,
  line: number,
  confidence = 0.86,
): void => {
  if (target.some(effect => effect.kind === kind)) return;
  target.push({ kind, line, confidence });
};

const addQueueAssignment = (
  target: PhpQueueAssignment[],
  queue: string,
  via: 'onQueue' | 'property',
  line: number,
  explicit: boolean,
  confidence = 0.95,
): void => {
  if (target.some(assignment => assignment.queue === queue && assignment.via === via)) return;
  target.push({ queue, via, line, explicit, confidence });
};

const detectQueueAssignmentOwner = (
  content: string,
  matchIndex: number,
  via: 'onQueue' | 'property',
): 'job' | 'batch' | 'chain' => {
  if (via === 'property') return 'job';
  const start = Math.max(0, matchIndex - 240);
  const window = content.slice(start, Math.max(start, matchIndex));
  if (/\bBus::batch\b[\s\S]{0,240}$/i.test(window)) return 'batch';
  if (/\bBus::chain\b[\s\S]{0,240}$/i.test(window)) return 'chain';
  return 'job';
};

export const extractPhpBehaviorCard = async (
  filePath: string,
  content: string,
): Promise<PhpBehaviorCard> => {
  const normalizedFilePath = String(filePath || '').trim();
  if (!/\.php$/i.test(normalizedFilePath)) {
    return EMPTY_CARD(normalizedFilePath);
  }

  const normalizedContent = String(content || '');
  const behaviorTags = new Set<PhpBehaviorTag>();
  const queueAssignments: PhpQueueAssignment[] = [];
  const deliveryEffects: PhpDeliveryEffect[] = [];
  const qrSignals: PhpQrSignal[] = [];
  const smells: PhpBehaviorSmell[] = [];

  const isSchedulerKernel = /(^|\/)Console\/Kernel\.php$/i.test(normalizedFilePath)
    || /\bextends\s+ConsoleKernel\b/.test(normalizedContent);
  const isConsoleCommand = normalizedFilePath.includes('/Console/Commands/')
    || /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+[A-Za-z_][A-Za-z0-9_]*Command\b/.test(normalizedContent);
  const isQueuedJobOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+Job\b/.test(normalizedContent)
    || (normalizedFilePath.includes('/Jobs/')
      && /\bimplements\s+[^{;]*(?:ShouldQueue|ShouldBeUnique|ShouldBeUniqueUntilProcessing)\b/.test(normalizedContent));
  const isQueuedMailOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseMailable\b/.test(normalizedContent)
    || (/\bextends\s+[A-Za-z_][A-Za-z0-9_]*Mailable\b/.test(normalizedContent) && /\bimplements\s+[^{;]*ShouldQueue\b/.test(normalizedContent));
  const isQueuedNotificationOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseNotification\b/.test(normalizedContent)
    || (/\bextends\s+[A-Za-z_][A-Za-z0-9_]*Notification\b/.test(normalizedContent) && /\bimplements\s+[^{;]*ShouldQueue\b/.test(normalizedContent));
  const isController = normalizedFilePath.includes('/Http/Controllers/');
  const isWebhookController = normalizedFilePath.includes('/Http/Controllers/Webhooks/');
  const isListener = normalizedFilePath.includes('/Listeners/');

  if (isSchedulerKernel) addTag(behaviorTags, 'scheduler-kernel-owner');
  if (isConsoleCommand) addTag(behaviorTags, 'console-command-owner');
  if (isQueuedJobOwner) addTag(behaviorTags, 'queued-job-owner');
  if (isQueuedMailOwner) addTag(behaviorTags, 'queued-mail-owner');
  if (isQueuedNotificationOwner) addTag(behaviorTags, 'queued-notification-owner');

  if (isSchedulerKernel && /\$schedule->job\s*\(/.test(normalizedContent)) {
    addTag(behaviorTags, 'scheduler-schedules-job');
  }

  if (isSchedulerKernel && /\$schedule->command\s*\(/.test(normalizedContent)) {
    addTag(behaviorTags, 'scheduler-schedules-command');
  }

  const hasDispatchCallsite =
    /\bdispatch\s*\(\s*new\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(normalizedContent)
    || /\b[A-Z][A-Za-z0-9_]*::dispatch(?:Sync)?\s*\(/.test(normalizedContent);
  const hasDispatchSyncCallsite =
    /\bdispatchSync\s*\(\s*new\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(normalizedContent)
    || /\b[A-Z][A-Za-z0-9_]*::dispatchSync\s*\(/.test(normalizedContent);
  const hasBatchOrchestration = /\bBus::batch\s*\(/.test(normalizedContent);
  const hasChainOrchestration = /\bBus::chain\s*\(/.test(normalizedContent);
  const hasAsyncDispatchOrchestration = hasDispatchCallsite || hasBatchOrchestration || hasChainOrchestration;

  if (hasDispatchSyncCallsite) {
    addTag(behaviorTags, 'dispatch-callsite-sync');
  }

  if (hasBatchOrchestration) {
    addTag(behaviorTags, 'dispatch-batch-orchestrator');
  }

  if (hasChainOrchestration) {
    addTag(behaviorTags, 'dispatch-chain-orchestrator');
  }

  if (isConsoleCommand && hasAsyncDispatchOrchestration) {
    addTag(behaviorTags, 'command-dispatch-callsite');
  }

  if (isController && hasAsyncDispatchOrchestration) {
    addTag(behaviorTags, 'controller-dispatch-callsite');
  }

  if (isWebhookController && hasAsyncDispatchOrchestration) {
    addTag(behaviorTags, 'webhook-dispatch-callsite');
  }

  if (isListener && hasAsyncDispatchOrchestration) {
    addTag(behaviorTags, 'listener-dispatch-callsite');
  }

  if (isQueuedJobOwner && hasAsyncDispatchOrchestration) {
    addTag(behaviorTags, 'queued-job-dispatch-callsite');
  }

  const queuePatterns: Array<{ via: 'onQueue' | 'property'; regex: RegExp; normalizer?: (value: string) => string }> = [
    {
      via: 'onQueue',
      regex: /->\s*onQueue\(\s*JobQueue::([A-Z_]+)(?:->value)?\s*\)/g,
      normalizer: value => String(value || '').toLowerCase(),
    },
    {
      via: 'onQueue',
      regex: /->\s*onQueue\(\s*['"]([^'"]+)['"]\s*\)/g,
    },
    {
      via: 'property',
      regex: /\$this->queue\s*=\s*JobQueue::([A-Z_]+)(?:->value)?/g,
      normalizer: value => String(value || '').toLowerCase(),
    },
    {
      via: 'property',
      regex: /\$this->queue\s*=\s*['"]([^'"]+)['"]/g,
    },
  ];

  for (const pattern of queuePatterns) {
    for (const match of collectMatches(normalizedContent, pattern.regex)) {
      const queue = pattern.normalizer ? pattern.normalizer(match[1] || '') : String(match[1] || '').trim();
      if (!queue) continue;
      const line = toLineNumber(normalizedContent, match.index ?? 0);
      const assignmentOwner = detectQueueAssignmentOwner(normalizedContent, match.index ?? 0, pattern.via);
      addQueueAssignment(queueAssignments, queue, pattern.via, line, true);
      addTag(behaviorTags, 'queue-assignment-explicit');
      addTag(
        behaviorTags,
        assignmentOwner === 'batch'
          ? 'queue-assignment-batch'
          : assignmentOwner === 'chain'
            ? 'queue-assignment-chain'
            : 'queue-assignment-job',
      );
      if (isMailQueueName(queue)) addTag(behaviorTags, 'queue-assignment-mail');
      if (isNotificationQueueName(queue)) addTag(behaviorTags, 'queue-assignment-notification');
    }
  }

  if (queueAssignments.length === 0 && isQueuedMailOwner) {
    addQueueAssignment(
      queueAssignments,
      'mail',
      'property',
      findFirstLine(normalizedContent, /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseMailable\b/),
      false,
      0.75,
    );
    addTag(behaviorTags, 'queue-assignment-inherited');
    addTag(behaviorTags, 'queue-assignment-mail');
  }

  if (queueAssignments.length === 0 && isQueuedNotificationOwner) {
    addQueueAssignment(
      queueAssignments,
      'notifications',
      'property',
      findFirstLine(normalizedContent, /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseNotification\b/),
      false,
      0.75,
    );
    addTag(behaviorTags, 'queue-assignment-inherited');
    addTag(behaviorTags, 'queue-assignment-notification');
  }

  const deliveryPatterns: Array<{ kind: PhpDeliveryEffectKind; regex: RegExp; tag: PhpBehaviorTag }> = [
    {
      kind: 'mail-queue',
      regex: /\bMail::(?:[\s\S]{0,160}?->\s*)?(?:queue|later)\s*\(/g,
      tag: 'delivery-mail-queue',
    },
    {
      kind: 'mail-send',
      regex: /\bMail::(?:[\s\S]{0,160}?->\s*)?send\s*\(/g,
      tag: 'delivery-mail-send',
    },
    {
      kind: 'notification-send',
      regex: /\bNotification::send\s*\(/g,
      tag: 'delivery-notification-send',
    },
    {
      kind: 'notify',
      regex: /->\s*notify\s*\(/g,
      tag: 'delivery-notify',
    },
  ];

  for (const pattern of deliveryPatterns) {
    for (const match of collectMatches(normalizedContent, pattern.regex)) {
      const line = toLineNumber(normalizedContent, match.index ?? 0);
      addDeliveryEffect(deliveryEffects, pattern.kind, line);
      addTag(behaviorTags, pattern.tag);
    }
  }

  const deliverySelectorPatterns: Array<{ regex: RegExp; tag: PhpBehaviorTag }> = [
    {
      regex: /\bMail::(?:[\s\S]{0,200}?->\s*)?(?:send|queue|later)\s*\(\s*(?:new\s+[$A-Za-z_\\][A-Za-z0-9_\\]*|[$A-Za-z_\\][A-Za-z0-9_\\]*(?:::[A-Za-z_][A-Za-z0-9_]*)?\s*\()/g,
      tag: 'delivery-selector-mail',
    },
    {
      regex: /\bNotification::send\s*\([^,]+,\s*(?:new\s+[$A-Za-z_\\][A-Za-z0-9_\\]*|[$A-Za-z_\\][A-Za-z0-9_\\]*(?:::[A-Za-z_][A-Za-z0-9_]*)?\s*\()/g,
      tag: 'delivery-selector-notification',
    },
    {
      regex: /->\s*notify\s*\(\s*(?:new\s+[$A-Za-z_\\][A-Za-z0-9_\\]*|[$A-Za-z_\\][A-Za-z0-9_\\]*(?:::[A-Za-z_][A-Za-z0-9_]*)?\s*\()/g,
      tag: 'delivery-selector-notification',
    },
  ];

  for (const pattern of deliverySelectorPatterns) {
    if (pattern.regex.test(normalizedContent)) {
      addTag(behaviorTags, pattern.tag);
    }
  }

  if (isQueuedJobOwner && deliveryEffects.some(effect => effect.kind === 'mail-send' || effect.kind === 'mail-queue')) {
    addTag(behaviorTags, 'job-orchestrates-mail-delivery');
  }

  if (isQueuedJobOwner && deliveryEffects.some(effect => effect.kind === 'notify' || effect.kind === 'notification-send')) {
    addTag(behaviorTags, 'job-orchestrates-notification-delivery');
  }

  const hasQrToken = /\bqr[\s_-]?code\b|\bQRCode\b|\bQrCode\b|\bqr-code-\b|\bqr_[a-z0-9_]+/i.test(normalizedContent)
    || /(^|\/)[^/]*qr[^/]*\.php$/i.test(normalizedFilePath);
  const isQrCrudController = normalizedFilePath.includes('/Http/Controllers/')
    && /QRCodeService/.test(normalizedContent)
    && /\b(public\s+)?function\s+(store|update|show)\b/.test(normalizedContent)
    && /\b(QrCodeResource|QrCode\s+\$qrCode|StoreQrCodeRequest|UpdateQrCodeRequest)\b/.test(normalizedContent);

  if (isQrCrudController) {
    addTag(behaviorTags, 'qr-crud-resource');
    addQrSignal(
      qrSignals,
      'qr-crud-resource',
      findFirstLine(normalizedContent, /\b(public\s+)?function\s+(store|update|show)\b/),
    );
  }

  if (isQrCrudController && /\bMailPieceResource\b|['"]mail_piece['"]/.test(normalizedContent)) {
    addTag(behaviorTags, 'qr-crud-mail-piece-sidecar');
    addQrSignal(
      qrSignals,
      'qr-crud-mail-piece-sidecar',
      findFirstLine(normalizedContent, /\bMailPieceResource\b|['"]mail_piece['"]/),
      0.92,
    );
  }

  if (hasQrToken && /\bPDF::chunkLoadView\b/.test(normalizedContent)) {
    addTag(behaviorTags, 'qr-export-inline-pdf');
    addQrSignal(
      qrSignals,
      'qr-export-inline-pdf',
      findFirstLine(normalizedContent, /\bPDF::chunkLoadView\b/),
    );
  }

  const isQrRedirectController = /(^|\/)Http\/Controllers\/QrCodeRedirectController\.php$/i.test(normalizedFilePath)
    || (/\bQrCode\s+\$qrCode\b/.test(normalizedContent)
      && /\bmarkAsScanned\s*\(/.test(normalizedContent)
      && /\bredirect\(\)->away\s*\(/.test(normalizedContent));

  if (isQrRedirectController) {
    addTag(behaviorTags, 'qr-redirect-entrypoint');
    addQrSignal(
      qrSignals,
      'qr-redirect-entrypoint',
      findFirstLine(normalizedContent, /\bmarkAsScanned\s*\(|\bredirect\(\)->away\s*\(/),
      0.94,
    );
  }

  if (hasQrToken && (/\bgetRedirectUrl\s*\(/.test(normalizedContent) || /route\(\s*['"]qr-codes\.redirect['"]/.test(normalizedContent))) {
    addTag(behaviorTags, 'qr-trackable-redirect-link');
    addQrSignal(
      qrSignals,
      'qr-trackable-redirect-link',
      findFirstLine(normalizedContent, /\bgetRedirectUrl\s*\(|route\(\s*['"]qr-codes\.redirect['"]/),
      0.91,
    );
  }

  if (/\bmakeBase64Svg\b/.test(normalizedContent) || /\bsetSvgContent\s*\(/.test(normalizedContent)) {
    addTag(behaviorTags, 'qr-svg-generation');
    addQrSignal(
      qrSignals,
      'qr-svg-generation',
      findFirstLine(normalizedContent, /\bmakeBase64Svg\b|\bsetSvgContent\s*\(/),
      0.88,
    );
  }

  if (/\bmakeBase64Svg\b/.test(normalizedContent) && /setAttribute\(\s*['"]src['"]/.test(normalizedContent)) {
    addTag(behaviorTags, 'qr-html-embed');
    addQrSignal(
      qrSignals,
      'qr-html-embed',
      findFirstLine(normalizedContent, /setAttribute\(\s*['"]src['"]/),
      0.92,
    );
  }

  if (/\bremoveQrCodesFromBody\b/.test(normalizedContent) || (/parentNode->removeChild/.test(normalizedContent) && /qr-code-/.test(normalizedContent))) {
    addTag(behaviorTags, 'qr-html-strip');
    addQrSignal(
      qrSignals,
      'qr-html-strip',
      findFirstLine(normalizedContent, /\bremoveQrCodesFromBody\b|parentNode->removeChild/),
      0.86,
    );
  }

  if (
    /\bQRCodeParser\b/.test(normalizedContent)
    && /\bMailPiece\b/.test(normalizedContent)
    && (
      /\breplaceQrCodes\s*\(/.test(normalizedContent)
      || /\bgetRedirectUrl\s*\(/.test(normalizedContent)
      || /\bSendEngageMailPieceToDirectMailService::dispatch\b/.test(normalizedContent)
    )
  ) {
    addTag(behaviorTags, 'qr-mail-piece-handoff');
    addQrSignal(
      qrSignals,
      'qr-mail-piece-handoff',
      findFirstLine(normalizedContent, /\breplaceQrCodes\s*\(|\bgetRedirectUrl\s*\(|\bSendEngageMailPieceToDirectMailService::dispatch\b/),
      0.93,
    );
  }

  queueAssignments.sort((left, right) => left.line - right.line || left.queue.localeCompare(right.queue));
  deliveryEffects.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
  qrSignals.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));

  return {
    filePath: normalizedFilePath,
    behaviorTags: Array.from(behaviorTags).sort(),
    queueAssignments,
    deliveryEffects,
    qrSignals,
    smells,
  };
};
