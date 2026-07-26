import type { FileKind } from './types';

export interface PreviewContent {
  title: string;
  meta: string;
  lines: readonly string[];
}

// 按文件类型提供稳定的本地预览内容，供首页交互直接复用。
export const CONTENT_POOL: Record<FileKind, readonly PreviewContent[]> = {
  txt: [
    { title: '今日备忘', meta: 'TXT · 刚刚', lines: ['整理项目素材', '确认下一阶段计划'] },
    { title: '灵感片段', meta: 'TXT · 2 KB', lines: ['让文件主动说明自己。'] }
  ],
  pdf: [
    { title: '项目说明书', meta: 'PDF · 12 页', lines: ['目标、边界与验收标准'] },
    { title: '研究摘要', meta: 'PDF · 8 页', lines: ['本地优先的文件协作方式'] }
  ],
  ppt: [
    { title: '产品演示', meta: 'PPT · 16 页', lines: ['问题', '方案', '下一步'] },
    { title: '周会汇报', meta: 'PPT · 9 页', lines: ['本周进度', '风险与安排'] }
  ],
  xls: [
    { title: '任务统计', meta: 'XLS · 24 行', lines: ['已完成 18', '进行中 4'] },
    { title: '文件清单', meta: 'XLS · 7 列', lines: ['文档 12', '图片 36'] }
  ],
  img: [
    { title: '界面参考', meta: 'PNG · 1920×1080', lines: ['浅灰背景', '透明主体'] },
    { title: '产品截图', meta: 'PNG · 1.8 MB', lines: ['桌面助手运行画面'] }
  ],
  empty: [
    { title: '空文件夹', meta: '0 个项目', lines: ['这里暂时没有文件'] },
    { title: '新建目录', meta: '刚刚创建', lines: ['等待添加内容'] }
  ],
  folder: [
    { title: '项目资料', meta: '5 个项目', lines: ['需求说明.pdf', '视觉参考.png'] },
    { title: '本周工作', meta: '3 个项目', lines: ['计划.txt', '进度.xlsx'] }
  ]
};

// 将随机源映射到条目索引，并保证索引不会超过最后一项。
export function pickPreview(kind: FileKind, random: () => number): PreviewContent {
  const entries = CONTENT_POOL[kind];
  const index = Math.min(entries.length - 1, Math.floor(random() * entries.length));

  return entries[index]!;
}
