import { describe, expect, test } from 'vitest';
import { ExplicitFileIntentGate } from '../src/main/conversation/explicit-file-intent-gate';

describe('ExplicitFileIntentGate', () => {
  test.each([
    '你好',
    '聊聊天吧',
    '我想和你聊天',
    '帮我整理一下',
    '如何更安全地删除文件',
    '不要删除 a.txt',
    '',
    '   ',
    'How do I delete a file safely?',
    '删除',
    'a.txt',
    './reports',
    '当前文件夹',
    '整理',
    '看看文件',
    '帮我',
    '不要重命名 report.md 为 archive.md',
    "Don't move a.txt",
    '请告诉我怎么读取 a.txt'
  ])('缺少三项证据之一时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each(['a.txt', './reports', '当前文件夹', 'README'])('只有文件对象时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each(['删除', 'Rename', '整理'])('只有文件操作时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    '为什么删除 a.txt 会有风险？',
    'The delete a.txt operation is dangerous.'
  ])('知识陈述而非实际执行请求时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    '读取 a.txt',
    '请列出当前文件夹',
    '删除当前文件夹里的 a.txt',
    '把 report.md 重命名为 archive.md',
    'Create notes.md',
    'WRITE ./notes.md',
    'Copy a.txt to b.txt',
    'move ./drafts to 当前目录',
    'Search 授权目录',
    '修改 README.MD',
    '整理当前目录中的文件',
    '删除 docs/guide',
    '读取 README'
  ])('明确请求实际操作文件实体时将“%s”归为文件任务', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'file_task' });
  });

  test('归一化 Unicode 与大小写后仍识别明确文件任务', () => {
    expect(ExplicitFileIntentGate.classify('ＲＥＮＡＭＥ cafe\u0301.TXT TO archive.txt'))
      .toEqual({ kind: 'file_task' });
  });
});
