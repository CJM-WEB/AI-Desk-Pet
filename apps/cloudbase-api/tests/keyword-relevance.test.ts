import { describe, expect, it } from 'vitest';

import {
  KeywordRelevanceClassifier,
  keywordRelevanceRuleVersion
} from '../src/services/keyword-relevance.js';

describe('本地关键词相关性分类器', () => {
  const classifier = new KeywordRelevanceClassifier();

  it('公开稳定的规则版本', () => {
    expect(keywordRelevanceRuleVersion)
      .toBe('keyword-relevance-2026-08-01');
  });

  it.each([
    ['AI桌宠导入新角色后闪退', ''],
    ['桌面宠物建议', '希望增加动作'],
    ['DESKTOP PET package', 'new skin'],
    ['ＡＩ　Ｐｅｔ', '导入资源包']
  ])('强产品词命中后通过：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('pass');
  });

  it.each([
    ['PNG', '拖拽'],
    ['PNG', '显示异常'],
    ['拖拽', '显示异常']
  ])('有效跨组组合通过：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('pass');
  });

  it.each([
    ['这个模型很好看', ''],
    ['希望支持这个功能', ''],
    ['今天天气不错', ''],
    ['AI petroleum', 'unrelated news'],
    ['mydesktop pet', 'unrelated news']
  ])('弱命中、零命中和英文子串转人工：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('review');
  });

  it('任何规则输入都不产生自动驳回', async () => {
    const decisions = await Promise.all([
      classifier.classify({ title: 'AI Pet', body: '' }),
      classifier.classify({ title: '模型', body: '' }),
      classifier.classify({ title: '', body: '' })
    ]);
    expect(decisions).not.toContain('reject');
  });

  it('规则异常时记录稳定错误码并转人工', async () => {
    const messages: string[] = [];
    const logger = {
      error: (message: string) => {
        messages.push(message);
        throw new Error('logger unavailable');
      }
    };
    const failingClassifier = new KeywordRelevanceClassifier(logger);
    const invalidInput = {
      title: { toString: () => { throw new Error('secret content'); } },
      body: ''
    } as never;

    await expect(failingClassifier.classify(invalidInput)).resolves.toBe('review');
    expect(messages).toEqual(['KEYWORD_RELEVANCE_RULE_ERROR']);
  });
});
