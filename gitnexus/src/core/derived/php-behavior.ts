export type PhpBehaviorTag =
  | 'queued-job-owner'
  | 'queued-mail-owner'
  | 'queued-notification-owner'
  | 'queue-assignment-explicit'
  | 'queue-assignment-inherited'
  | 'queue-assignment-mail'
  | 'queue-assignment-notification'
  | 'delivery-mail-send'
  | 'delivery-mail-queue'
  | 'delivery-notify'
  | 'delivery-notification-send'
  | 'job-orchestrates-mail-delivery'
  | 'job-orchestrates-notification-delivery'
  | 'qr-crud-resource'
  | 'qr-crud-mail-piece-sidecar'
  | 'qr-export-inline-pdf'
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

  const isQueuedJobOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+Job\b/.test(normalizedContent);
  const isQueuedMailOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseMailable\b/.test(normalizedContent)
    || (/\bextends\s+[A-Za-z_][A-Za-z0-9_]*Mailable\b/.test(normalizedContent) && /\bimplements\s+[^{;]*ShouldQueue\b/.test(normalizedContent));
  const isQueuedNotificationOwner = /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+BaseNotification\b/.test(normalizedContent)
    || (/\bextends\s+[A-Za-z_][A-Za-z0-9_]*Notification\b/.test(normalizedContent) && /\bimplements\s+[^{;]*ShouldQueue\b/.test(normalizedContent));

  if (isQueuedJobOwner) addTag(behaviorTags, 'queued-job-owner');
  if (isQueuedMailOwner) addTag(behaviorTags, 'queued-mail-owner');
  if (isQueuedNotificationOwner) addTag(behaviorTags, 'queued-notification-owner');

  const queuePatterns: Array<{ via: 'onQueue' | 'property'; regex: RegExp; normalizer?: (value: string) => string }> = [
    {
      via: 'onQueue',
      regex: /->\s*onQueue\(\s*JobQueue::([A-Z_]+)(?:->value)?\s*\)/g,
      normalizer: value => String(value || '').toLowerCase(),
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
      addQueueAssignment(queueAssignments, queue, pattern.via, line, true);
      addTag(behaviorTags, 'queue-assignment-explicit');
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
