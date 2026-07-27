import { readFile, rename, stat } from 'node:fs/promises';
import { z } from 'zod';
import { disclosureCategorySchema } from '../agent/disclosure-policy';
import {
  atomicWriteText,
  canonicalFilePath,
  enqueueFileOperation,
  uniqueCorruptFile
} from '../storage/atomic-file-coordinator';

const auditActionSchema = z.enum([
  'disclosure',
  'memory_read',
  'memory_write',
  'memory_delete',
  'permission_decision',
  'proactivity_decision'
]);
const auditCategorySchema = z.union([
  disclosureCategorySchema,
  z.enum(['tool', 'system'])
]);
const auditOutcomeSchema = z.enum(['allowed', 'denied', 'success', 'failure']);
const providerIdentitySchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
export const auditDetailCodeSchema = z.enum([
  'CONVERSATION_DISCLOSED',
  'FILE_METADATA_DISCLOSED',
  'SCREENSHOT_METADATA_DISCLOSED',
  'CLIPBOARD_METADATA_DISCLOSED',
  'MEMORY_METADATA_DISCLOSED',
  'MEMORY_ITEM_CHANGED',
  'MEMORY_ITEM_DELETED',
  'PERMISSION_ALLOWED',
  'PERMISSION_DENIED',
  'PROACTIVITY_EXECUTED',
  'PROACTIVITY_BLOCKED'
]);
export type AuditDetailCode = z.infer<typeof auditDetailCodeSchema>;

const redactedSummarySchema = z.object({
  detailCode: auditDetailCodeSchema.optional(),
  itemCount: z.number().int().min(0).max(100_000).optional(),
  byteLength: z.number().int().min(0).max(100_000_000).optional()
}).strict();
const auditRecordBaseSchema = z.object({
  action: auditActionSchema,
  category: auditCategorySchema,
  outcome: auditOutcomeSchema,
  redactedSummary: redactedSummarySchema
}).strict();
const auditInputSchema = auditRecordBaseSchema.extend({
  targetProfileId: z.string().min(1).max(128).nullable()
}).strict();
const storedAuditRecordSchema = auditRecordBaseSchema.extend({
  targetProviderIdentity: providerIdentitySchema.nullable(),
  timestamp: z.string().datetime()
}).strict();
const auditFileSchema = z.object({
  version: z.literal(1),
  records: z.array(storedAuditRecordSchema)
}).strict();

export type AuditRecordInput = z.input<typeof auditInputSchema>;
export type AuditRecord = z.infer<typeof storedAuditRecordSchema>;

export interface AuditWriterOptions {
  maxRecords?: number;
  maxFileBytes?: number;
}

export type AuditProviderResolver = (profileId: string) => string | null;

const DEFAULT_MAX_RECORDS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 2_097_152;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function cloneRecord(record: AuditRecord): AuditRecord {
  return {
    ...record,
    redactedSummary: { ...record.redactedSummary }
  };
}

export class AuditWriter {
  private readonly file: string;
  private readonly maxRecords: number;
  private readonly maxFileBytes: number;

  constructor(
    file: string,
    private readonly resolveProviderIdentity: AuditProviderResolver,
    options: AuditWriterOptions = {}
  ) {
    this.file = canonicalFilePath(file);
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  append(input: AuditRecordInput): Promise<AuditRecord> {
    return this.enqueue(async () => {
      const parsed = auditInputSchema.safeParse(input);
      if (!parsed.success) throw new Error('AUDIT_RECORD_INVALID');
      const auditFile = await this.load();
      if (auditFile.records.length >= this.maxRecords) {
        throw new Error('AUDIT_LIMIT_EXCEEDED');
      }
      const targetProviderIdentity = this.resolveTargetProvider(
        parsed.data.targetProfileId
      );
      const record: AuditRecord = {
        action: parsed.data.action,
        category: parsed.data.category,
        targetProviderIdentity,
        outcome: parsed.data.outcome,
        redactedSummary: parsed.data.redactedSummary,
        timestamp: new Date().toISOString()
      };
      auditFile.records.push(record);
      await this.write(auditFile);
      return cloneRecord(record);
    });
  }

  list(): Promise<AuditRecord[]> {
    return this.enqueue(async () => (await this.load()).records.map(cloneRecord));
  }

  clear(): Promise<void> {
    return this.enqueue(() => this.write({ version: 1, records: [] }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueFileOperation(this.file, async () => {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof Error
          && /^AUDIT_[A-Z_]+$/u.test(error.message)
        ) {
          throw error;
        }
        throw new Error('AUDIT_STORAGE_FAILED');
      }
    });
  }

  private resolveTargetProvider(profileId: string | null): string | null {
    if (profileId === null) return null;
    let providerIdentity: string | null;
    try {
      providerIdentity = this.resolveProviderIdentity(profileId);
    } catch {
      throw new Error('AUDIT_PROVIDER_UNKNOWN');
    }
    const parsed = providerIdentitySchema.safeParse(providerIdentity);
    if (!parsed.success) throw new Error('AUDIT_PROVIDER_UNKNOWN');
    return parsed.data;
  }

  private async load(): Promise<z.infer<typeof auditFileSchema>> {
    try {
      const fileStats = await stat(this.file);
      if (fileStats.size > this.maxFileBytes) {
        return this.quarantineCorruptFile();
      }
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const parsed = auditFileSchema.safeParse(raw);
      if (!parsed.success || parsed.data.records.length > this.maxRecords) {
        return this.quarantineCorruptFile();
      }
      return {
        version: 1,
        records: parsed.data.records.map(cloneRecord)
      };
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, records: [] };
      return this.quarantineCorruptFile();
    }
  }

  private async quarantineCorruptFile(): Promise<z.infer<typeof auditFileSchema>> {
    try {
      await rename(this.file, uniqueCorruptFile(this.file));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return { version: 1, records: [] };
  }

  private async write(auditFile: z.infer<typeof auditFileSchema>): Promise<void> {
    const content = `${JSON.stringify(auditFile, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new Error('AUDIT_LIMIT_EXCEEDED');
    }
    await atomicWriteText(this.file, content);
  }
}
