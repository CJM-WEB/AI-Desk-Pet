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
    '请告诉我怎么读取 a.txt',
    '读取 a.txt 是什么意思？',
    '搜索文件是什么功能？',
    '把“删除 a.txt”这句话翻译成英文',
    'read https://example.com/manual.pdf',
    '关于 a.txt 的删除操作',
    'Can you please frobnicate a.txt?'
  ])('缺少三项证据之一时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    'a.txt',
    './reports',
    '当前文件夹',
    'README',
    '删除.txt',
    'read.txt'
  ])('只有文件对象时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each(['删除', 'Rename', '整理'])('只有文件操作时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    '为什么删除 a.txt 会有风险？',
    'The delete a.txt operation is dangerous.',
    '删除 a.txt 需要管理员权限。'
  ])('知识陈述而非实际执行请求时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    '读取 a.txt',
    '请列出当前文件夹',
    '删除当前文件夹里的 a.txt',
    '把 report.md 重命名为 archive.md',
    'WRITE ./notes.md',
    'Copy a.txt to b.txt',
    'move ./drafts to 当前目录',
    'Search 授权目录',
    '整理当前目录中的文件',
    '删除 docs/guide',
    '读取 README',
    '在当前目录中删除 a.txt',
    'delete permission.txt',
    'delete will.txt',
    'delete docs/permission',
    '请把 report.md 重命名为 archive.md',
    '帮我把 report.md 重命名为 archive.md',
    'Can you delete a.txt?',
    '列出 .\\drafts',
    '读取 pyproject.toml',
    '读取 不要删除.txt',
    'read report.v2.txt'
  ])('明确请求实际操作文件实体时将“%s”归为文件任务', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'file_task' });
  });

  test.each([
    '你能帮我读取 a.txt 吗？',
    'Can you please delete a.txt?',
    'Could you read pyproject.toml?',
    'Would you please list .\\drafts?'
  ])('礼貌请求实际操作文件实体时将“%s”归为文件任务', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'file_task' });
  });

  test.each([
    '读取 a.txt是什么意思？',
    '读取 a.txt为什么失败？',
    'Can you explain why reading a.txt failed?'
  ])('讨论文件操作而非要求执行时将“%s”归为普通聊天', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    'read www.example.com/manual.pdf',
    'read www.example.com',
    'read example.com',
    'read example.com/manual.pdf',
    'read ftp.example.com',
    'read report.com',
    'read example.museum',
    'read report.md',
    'Create notes.md',
    '修改 README.MD',
    '读取 需要.md',
    'delete user@example.com',
    'Can you delete version 1.2?',
    'read release 2.0.1',
    'delete version=1.2'
  ])('非本地点号 token“%s”不进入文件任务', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    'read ./report.md',
    'read file report.md',
    'rename report.md to archive.md'
  ])('显式本地限定或强文件结构使“%s”进入文件任务', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'file_task' });
  });

  test('英文句号隔开的操作与目标不组成文件任务', () => {
    expect(ExplicitFileIntentGate.classify('Delete nothing. a.txt'))
      .toEqual({ kind: 'chat' });
  });

  test.each([
    'Read the phrase "delete a.txt" aloud',
    "Read the phrase 'delete a.txt' aloud",
    '读取“删除 a.txt”这句话'
  ])('引号内引用不为“%s”提供文件执行证据', text => {
    expect(ExplicitFileIntentGate.classify(text)).toEqual({ kind: 'chat' });
  });

  test('英文词内撇号不屏蔽真实操作与本地对象', () => {
    expect(ExplicitFileIntentGate.classify("Can you read Bob's a.txt because it's ready?"))
      .toEqual({ kind: 'file_task' });
  });

  test('未知礼貌动词不能借用句尾操作词填充执行槽', () => {
    expect(ExplicitFileIntentGate.classify(
      'Can you please frobnicate a.txt while we discuss delete'
    )).toEqual({ kind: 'chat' });
  });

  test('适度长且以分隔符结尾的畸形 token 保持普通聊天', () => {
    const malformedToken = 'segment/'.repeat(128);
    expect(ExplicitFileIntentGate.classify(`read ${malformedToken}`))
      .toEqual({ kind: 'chat' });
  });

  test('归一化 Unicode 与大小写后仍识别明确文件任务', () => {
    expect(ExplicitFileIntentGate.classify('ＲＥＮＡＭＥ cafe\u0301.TXT TO archive.txt'))
      .toEqual({ kind: 'file_task' });
  });
});
