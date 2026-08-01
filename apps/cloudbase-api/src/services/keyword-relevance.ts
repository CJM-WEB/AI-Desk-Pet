import type {
  RelevanceClassifier,
  RelevanceInput,
  RelevanceSuggestion
} from '../ports.js';

export const keywordRelevanceRuleVersion =
  'keyword-relevance-2026-08-01';

const strongProductPatterns = [
  /\bai\s*pet\b/iu,
  /ai\s*桌宠/iu,
  /桌面宠物/u,
  /桌宠/u,
  /\bdesktop\s+pet\b/iu
] as const;

const resourcePatterns = [
  /角色|模型|皮肤|贴图|动画|动作|资源包|压缩包/u,
  /\b(?:json|png|jpe?g|webp)\b/iu
] as const;

const functionPatterns = [
  /跟随鼠标|拖拽|点击互动|待机|移动|缩放|透明度|置顶|开机启动|托盘|导入|上传|下载|加载/u
] as const;

const issuePatterns = [
  /闪退|卡顿|无法启动|导入失败|显示异常|兼容性|建议|反馈|希望增加|能否支持/u
] as const;

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function normalizeInput(input: RelevanceInput): string {
  return `${input.title}\n${input.body}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 使用确定性的分组关键词给出相关性建议；任何不确定情况均转人工。 */
export class KeywordRelevanceClassifier implements RelevanceClassifier {
  async classify(input: RelevanceInput): Promise<RelevanceSuggestion> {
    try {
      const text = normalizeInput(input);
      if (hasAny(text, strongProductPatterns)) return 'pass';

      const hasResource = hasAny(text, resourcePatterns);
      const hasFunction = hasAny(text, functionPatterns);
      const hasIssue = hasAny(text, issuePatterns);
      return Number(hasResource) + Number(hasFunction) + Number(hasIssue) >= 2
        ? 'pass'
        : 'review';
    } catch {
      return 'review';
    }
  }
}
