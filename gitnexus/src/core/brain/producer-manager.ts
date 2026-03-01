import {
  BRAIN_PRODUCER_REPORT_SCHEMA_VERSION,
  BrainProducer,
  ProducerContext,
  ProducerRunReport,
  ValidatedBrainArtifact,
} from './types.js';

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
};

const collectInvalidArtifactWarnings = (artifacts: ValidatedBrainArtifact[]): string[] => {
  const warnings: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.validation.valid) continue;
    const issueSummary = artifact.validation.issues.slice(0, 3).join('; ');
    warnings.push(`artifact:${artifact.id} invalid${issueSummary ? ` (${issueSummary})` : ''}`);
  }
  return warnings;
};

export class ProducerManager {
  private producers: BrainProducer[];

  constructor(producers: BrainProducer[] = []) {
    this.producers = [...producers];
  }

  register(producer: BrainProducer): void {
    const existingIndex = this.producers.findIndex(item => item.id === producer.id);
    if (existingIndex >= 0) {
      this.producers[existingIndex] = producer;
      return;
    }
    this.producers.push(producer);
  }

  list(): BrainProducer[] {
    return [...this.producers];
  }

  async run(ctx: ProducerContext): Promise<ProducerRunReport[]> {
    const reports: ProducerRunReport[] = [];

    for (const producer of this.producers) {
      const startedAt = Date.now();
      const reportBase = {
        schemaVersion: BRAIN_PRODUCER_REPORT_SCHEMA_VERSION,
        producerId: producer.id,
        producerVersion: producer.version,
        kind: producer.kind,
      };

      try {
        const detected = await producer.detect(ctx);
        if (!detected) {
          reports.push({
            ...reportBase,
            status: 'skipped',
            detected,
            artifactCount: 0,
            validArtifactCount: 0,
            durationMs: Date.now() - startedAt,
            warnings: [],
          });
          continue;
        }

        const producedArtifacts = await producer.produce(ctx);
        const validatedArtifacts = await producer.validate(producedArtifacts, ctx);
        const validArtifacts = validatedArtifacts.filter(item => item.validation.valid);
        await producer.integrate(validArtifacts, ctx);

        const forgetWarnings: string[] = [];
        try {
          await producer.forget(ctx);
        } catch (error) {
          forgetWarnings.push(`forget failed (${toErrorMessage(error)})`);
        }

        let scoreWarnings: string[] = [];
        let score: ProducerRunReport['score'] | undefined;
        try {
          score = await producer.score(ctx);
          scoreWarnings = score.warnings || [];
        } catch (error) {
          scoreWarnings = [`score failed (${toErrorMessage(error)})`];
        }

        reports.push({
          ...reportBase,
          status: 'ok',
          detected,
          artifactCount: producedArtifacts.length,
          validArtifactCount: validArtifacts.length,
          durationMs: Date.now() - startedAt,
          ...(score ? { score } : {}),
          warnings: [
            ...collectInvalidArtifactWarnings(validatedArtifacts),
            ...scoreWarnings,
            ...forgetWarnings,
          ],
        });
      } catch (error) {
        reports.push({
          ...reportBase,
          status: 'error',
          detected: true,
          artifactCount: 0,
          validArtifactCount: 0,
          durationMs: Date.now() - startedAt,
          warnings: [toErrorMessage(error)],
        });
      }
    }

    return reports;
  }
}
