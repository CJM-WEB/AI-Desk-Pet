import { describe, expect, it } from 'vitest';
import {
  adminActionSchema,
  submissionReceiptSchema,
  submissionStatusSchema,
  submissionStatusViewSchema
} from '../src/moderation';

describe('投稿审核契约', () => {
  it('只接受已定义状态', () => {
    expect(submissionStatusSchema.parse('system_reviewing')).toBe('system_reviewing');
    expect(() => submissionStatusSchema.parse('approved')).toThrow();
  });

  it('管理员批准必须携带版本和幂等键', () => {
    expect(adminActionSchema.parse({
      action: 'approve',
      version: 3,
      idempotencyKey: 'idem-00000001',
      reason: '系统误判，人工复核通过'
    }).version).toBe(3);
  });

  it('状态查询令牌必须恰好为 43 个 URL 安全字符', () => {
    const statusToken = 'a'.repeat(43);

    expect(submissionReceiptSchema.parse({
      submissionId: 'submission-1',
      statusToken,
      statusPath: '/submission-status/',
      status: 'uploading'
    }).statusToken).toBe(statusToken);
    expect(() => submissionReceiptSchema.parse({
      submissionId: 'submission-1',
      statusToken: 'a'.repeat(42),
      statusPath: '/submission-status/',
      status: 'system_reviewing'
    })).toThrow();
  });

  it('投稿回执只接受上传中或系统审核中状态', () => {
    const receipt = {
      submissionId: 'submission-1',
      statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/'
    };

    expect(submissionReceiptSchema.parse({
      ...receipt,
      status: 'uploading'
    }).status).toBe('uploading');
    expect(submissionReceiptSchema.parse({
      ...receipt,
      status: 'system_reviewing'
    }).status).toBe('system_reviewing');
    expect(() => submissionReceiptSchema.parse({
      ...receipt,
      status: 'published'
    })).toThrow();
  });

  it('状态视图要求带时区偏移的创建和更新时间', () => {
    const view = {
      submissionId: 'submission-1',
      status: 'published',
      publicReason: null,
      createdAt: '2026-07-30T12:00:00+08:00',
      updatedAt: '2026-07-30T12:01:00+08:00'
    };

    expect(submissionStatusViewSchema.parse(view)).toEqual(view);
    expect(() => submissionStatusViewSchema.parse({
      ...view,
      updatedAt: '2026-07-30T12:01:00'
    })).toThrow();
  });
});
