import type { FeedbackRecord } from './feedback-types';

/** 官方示例集中维护，仅用于首屏展示和后续粒子预览，不写入本地 entries。 */
export const OFFICIAL_EXAMPLE_ENTRIES: readonly FeedbackRecord[] = [
  {
    id: 'official-feedback-01',
    kind: 'feedback',
    authorId: 'official',
    authorName: '林间用户',
    content: '希望桌面宠物能在专注模式下更安静一些，减少不必要的打扰。',
    likeCount: 28,
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-feedback-02',
    kind: 'feedback',
    authorId: 'official',
    authorName: '夜航者',
    content: '文件整理建议很实用，期待能看到一次操作完成后的清晰反馈。',
    likeCount: 19,
    createdAt: '2026-07-19T10:00:00.000Z',
    updatedAt: '2026-07-19T10:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-feedback-03',
    kind: 'feedback',
    authorId: 'official',
    authorName: '桌面观察员',
    content: '聊天陪伴的语气自然，希望不同心情下能有更多回应变化。',
    likeCount: 16,
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-feedback-04',
    kind: 'feedback',
    authorId: 'official',
    authorName: '微光',
    content: '首次使用的引导已经很直观，期待在设置入口增加更明确的说明。',
    likeCount: 12,
    createdAt: '2026-07-17T14:00:00.000Z',
    updatedAt: '2026-07-17T14:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-feedback-05',
    kind: 'feedback',
    authorId: 'official',
    authorName: '简白',
    content: '应用启动速度不错，希望窗口切换时宠物动作也能保持流畅。',
    likeCount: 9,
    createdAt: '2026-07-16T11:00:00.000Z',
    updatedAt: '2026-07-16T11:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-feedback-06',
    kind: 'feedback',
    authorId: 'official',
    authorName: '纸飞机',
    content: '图标交互很有趣，盼望后续可按自己的习惯调整显示密度。',
    likeCount: 7,
    createdAt: '2026-07-15T16:00:00.000Z',
    updatedAt: '2026-07-15T16:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-01',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '柏舟',
    content: '建议加入一键收起桌面宠物的快捷操作，方便临时分享屏幕。',
    likeCount: 34,
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-20T12:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-02',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '小北',
    content: '希望文件整理能够提供撤销入口，让尝试新规则时更放心。',
    likeCount: 27,
    createdAt: '2026-07-19T13:00:00.000Z',
    updatedAt: '2026-07-19T13:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-03',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '南风',
    content: '可以增加任务完成时的小结，让长期使用更容易看到自己的进度。',
    likeCount: 21,
    createdAt: '2026-07-18T15:00:00.000Z',
    updatedAt: '2026-07-18T15:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-04',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '零点',
    content: '期待增加深色模式，并让宠物外观随系统主题自然切换。',
    likeCount: 18,
    createdAt: '2026-07-17T17:00:00.000Z',
    updatedAt: '2026-07-17T17:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-05',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '拾光',
    content: '建议聊天记录支持导出，便于把有用的整理结果留存下来。',
    likeCount: 13,
    createdAt: '2026-07-16T18:00:00.000Z',
    updatedAt: '2026-07-16T18:00:00.000Z',
    source: 'official-example'
  },
  {
    id: 'official-suggestion-06',
    kind: 'suggestion',
    authorId: 'official',
    authorName: '午后',
    content: '希望安装包页面能同步展示更新摘要，方便判断是否需要升级。',
    likeCount: 8,
    createdAt: '2026-07-15T19:00:00.000Z',
    updatedAt: '2026-07-15T19:00:00.000Z',
    source: 'official-example'
  }
];
