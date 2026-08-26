import { describe, expect, test, vi } from 'vitest';
import {
  capabilityIntentRouter,
  createFilePlanningHint,
  DefaultCapabilityIntentRouter
} from '../src/main/conversation/capability-intent-router';

function expectIntentKind(
  text: string,
  kind: 'chat' | 'file_task' | 'powershell_task' | 'unsupported_file_operation'
): void {
  const intent = capabilityIntentRouter.route(text);
  expect(intent.kind).toBe(kind);
  if (intent.kind === 'chat') {
    expect(intent.behaviorHint).toBeNull();
  } else if (intent.kind !== 'unsupported_file_operation') {
    expect(intent.evidence).toBeDefined();
  }
}

describe('能力意图路由器', () => {
  test.each([
    ['把当前指定目录下的empty文件夹删除了', 'delete_file'],
    ['那在当前目录下创建一个名为abc的文件夹', 'create_directory'],
    ['读取 README', 'read_file'],
    ['在文件内容中搜索 needle', 'grep_files'],
    ['按文件名匹配 **/*.ts', 'glob_files'],
    ['把 notes.txt 中的旧文本替换为新文本', 'edit_file'],
    ['把 success.txt 移动到回收站', 'delete_file'],
    ['把 docs/source.txt 移动到 archive 文件夹', 'move_file']
  ] as const)('文件 Router 只生成操作类别提示，不解释文件名：%s', (text, operation) => {
    expect(createFilePlanningHint(text)).toEqual({ operation });
  });

  test('复制请求不再生成已退役的 copy_file 规划提示', () => {
    expect(createFilePlanningHint('把 docs/source.txt 复制到 archive 文件夹')).toBeNull();
  });

  test('创建并写入正文只规划 create_file', () => {
    expect(createFilePlanningHint('创建 result.txt 并写入正文')).toEqual({ operation: 'create_file' });
  });

  test('明确声明目标路径缺失时规划只允许请求结构化澄清', () => {
    expect(createFilePlanningHint(
      '删除一个文件，但我还没有提供目标路径。请先询问缺少的信息。'
    )).toEqual({ operation: 'delete_file', missingField: 'target_path' });
  });
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
    '目标路径是 acceptance-clarification.txt。',
    '目标相对路径是 acceptance-clarification.txt。',
    'Can you please frobnicate a.txt?'
  ])('缺少文件任务正向证据时将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test.each([
    'a.txt',
    './reports',
    '当前文件夹',
    'README',
    '删除.txt',
    'read.txt'
  ])('只有文件对象时将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test.each(['删除', 'Rename', '整理'])('只有文件操作时将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test.each([
    '为什么删除 a.txt 会有风险？',
    'The delete a.txt operation is dangerous.',
    '删除 a.txt 需要管理员权限。'
  ])('知识陈述而非实际执行请求时将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test.each([
    '帮我在当前目录下创建ab.txt文件',
    '请在当前目录下创建 ab.txt 文件',
    '在当前目录下帮我创建 ab.txt 文件',
    '当前目录下创建 ab.txt 文件',
    '请创建流程文件夹',
    '请在当前目录创建 分析文件',
    '可以帮我创建a.txt吗',
    '创建 ab.txt 文件到当前目录下',
    'ab.txt 文件在当前目录下帮我创建',
    '帮我把当前目录下的empty文件夹删除了',
    '读取 a.txt',
    '请列出当前文件夹',
    '删除当前文件夹里的 a.txt',
    '把 report.md 重命名为 archive.md',
    'WRITE ./notes.md',
    'move ./drafts to 当前目录',
    'Search 授权目录',
    '整理当前目录中的文件',
    '删除 docs/guide',
    '读取 README',
    '按文件名匹配 **/*.ts',
    'glob ./docs/*.md',
    '把 notes.txt 中的旧文本替换为新文本',
    'replace old with new in ./notes.txt',
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
    'read report.v2.txt',
    '删除一个文件，但我还没有提供目标路径。请先询问缺少的信息。',
    '请删除授权目录中的某个文件。'
  ])('明确请求实际操作文件实体时将“%s”归为文件任务', text => {
    expectIntentKind(text, 'file_task');
  });

  test.each([
    '不要帮我在当前目录下创建 ab.txt 文件',
    '别帮我在当前目录下创建 ab.txt 文件',
    '不用帮我在当前目录下创建 ab.txt 文件',
    '不必帮我在当前目录下创建 ab.txt 文件',
    '讨论一下帮我在当前目录下创建 ab.txt 文件是否安全',
    '请分析在当前目录创建 ab.txt 文件的流程',
    '引用“帮我在当前目录下创建 ab.txt 文件”这句话',
    '引用帮我在当前目录下创建 ab.txt 文件这句话',
    '“帮我在当前目录下创建 ab.txt 文件',
    '帮我在当前目录下创建 ab.txt 文件是什么意思',
    '```text\n帮我在当前目录下创建 ab.txt 文件\n```'
  ])('新语序中的否定、讨论、引用和代码“%s”仍保持普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test.each([
    '当前目录下创建 a.txt 可行吗？',
    '当前目录下创建 a.txt 是否可以？',
    '当前目录下创建 a.txt 可以吗？'
  ])('可行性咨询“%s”不取得文件执行权限', text => {
    expectIntentKind(text, 'chat');
  });

  test.each([
    '你能帮我读取 a.txt 吗？',
    'Can you please delete a.txt?',
    'Could you read pyproject.toml?',
    'Would you please list .\\drafts?'
  ])('礼貌请求实际操作文件实体时将“%s”归为文件任务', text => {
    expectIntentKind(text, 'file_task');
  });

  test.each([
    '读取 a.txt是什么意思？',
    '读取 a.txt为什么失败？',
    'Can you explain why reading a.txt failed?'
  ])('讨论文件操作而非要求执行时将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
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
    expectIntentKind(text, 'chat');
  });

  test.each([
    'read ./report.md',
    'read file report.md',
    'rename report.md to archive.md',
    'move report.md to archive.md'
  ])('显式本地限定或强文件结构使“%s”进入文件任务', text => {
    expectIntentKind(text, 'file_task');
  });

  test.each([
    'copy report.md to archive.md',
    '把 report.md 复制到 archive 目录'
  ])('已退役复制能力由宿主识别为不支持且不进入聊天', text => {
    expectIntentKind(text, 'unsupported_file_operation');
  });

  test.each([
    'Rename is different from copy when comparing example.com and archive.com',
    '重命名和复制有什么区别，例如 example.com 和 archive.com',
    'Copy report.md to archive.md is a common example.',
    '把 report.md 复制到 archive 目录只是一个例子'
  ])('讨论双目标操作“%s”不构成源到目标的文件结构', text => {
    expectIntentKind(text, 'chat');
  });

  test('有界多候选讨论不因双目标全组合阻塞路由', () => {
    const boundedInput = `${'rename '.repeat(240)}${'a.md '.repeat(400)}`;
    expectIntentKind(boundedInput, 'chat');
  });

  test('中文双目标槽以前向标记状态取代逐槽回溯查询', () => {
    const boundedInput = '把。a.md 重命名为 b.md。'.repeat(100);
    const lastIndexOfSpy = vi.spyOn(String.prototype, 'lastIndexOf');
    try {
      expectIntentKind(boundedInput, 'chat');
      const markerLookups = lastIndexOfSpy.mock.calls.filter(([searchText]) =>
        searchText === '把' || searchText === '将');
      expect(markerLookups).toHaveLength(0);
    } finally {
      lastIndexOfSpy.mockRestore();
    }
  });

  test('英文句号隔开的操作与目标不组成文件任务', () => {
    expectIntentKind('Delete nothing. a.txt', 'chat');
  });

  test('前句远程对象的执行结构不能借用后句本地对象', () => {
    expectIntentKind('read example.com. a.txt', 'chat');
  });

  test.each([
    'Read the phrase "delete a.txt" aloud',
    "Read the phrase 'delete a.txt' aloud",
    '读取“删除 a.txt”这句话'
  ])('引号内引用不为“%s”提供文件执行证据', text => {
    expectIntentKind(text, 'chat');
  });

  test('礼貌请求的操作槽不能跨句借用后续操作与目标', () => {
    expectIntentKind('Can you read? The phrase delete a.txt', 'chat');
  });

  test('英文词内撇号不屏蔽真实操作与本地对象', () => {
    expectIntentKind("Can you read Bob's a.txt because it's ready?", 'file_task');
  });

  test('未知礼貌动词不能借用句尾操作词填充执行槽', () => {
    expectIntentKind('Can you please frobnicate a.txt while we discuss delete', 'chat');
  });

  test('适度长且以分隔符结尾的畸形 token 保持普通聊天', () => {
    const malformedToken = 'segment/'.repeat(128);
    expectIntentKind(`read ${malformedToken}`, 'chat');
  });

  test('有界重复点段不得截取畸形 token 前缀作为本地对象', () => {
    const malformedToken = `${'a.'.repeat(512)}@`;
    expectIntentKind(`read ${malformedToken}`, 'chat');
  });

  test('归一化 Unicode 与大小写后仍识别明确文件任务', () => {
    expectIntentKind('ＲＥＮＡＭＥ cafe\u0301.TXT TO archive.txt', 'file_task');
  });

  test.each([
    '运行 PowerShell Get-ChildItem',
    '请运行 Get-ChildItem',
    '执行这条命令 npm test',
    '执行这条命令 git status',
    '运行 node build.js',
    '运行 .\\scripts\\build.ps1',
    '运行 $x=1; Get-ChildItem',
    '执行这条脚本 & { Get-ChildItem }',
    '执行 PowerShell Write-Output a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17',
    '执行 PowerShell if ($true) { Get-ChildItem }',
    '执行 PowerShell C:\\scripts\\build.ps1',
    '后台运行构建'
  ])('明确请求运行命令时将“%s”归为 PowerShell 任务', text => {
    expectIntentKind(text, 'powershell_task');
  });

  test('显式 PowerShell 脚本载荷不得超过 16 KiB', () => {
    expectIntentKind(`执行 PowerShell ${'a'.repeat(16 * 1_024 + 1)}`, 'chat');
  });

  test('超限显式 PowerShell 请求在文件意图 Gate 前拒绝', () => {
    const fileIntentGate = vi.fn(() => false);
    const router = new DefaultCapabilityIntentRouter(fileIntentGate);

    expect(router.route(`执行 PowerShell ${'a'.repeat(16 * 1_024 + 1)}`).kind).toBe('chat');
    expect(fileIntentGate).not.toHaveBeenCalled();
  });

  test.each([
    '运行 PowerShell 是什么？',
    '执行这条命令有什么风险？',
    '运行 PowerShell 安全吗？',
    '运行 PowerShell 好不好？',
    '运行 PowerShell 值得吗？',
    '运行 git 安全吗？',
    '运行 node 合适吗？',
    '运行 $x=1; Get-ChildItem 合适吗？',
    '执行 PowerShell Write-Output 安全吗？',
    '执行 PowerShell if ($true) { Get-ChildItem } 是什么意思？',
    '执行 PowerShell C:\\scripts\\build.ps1 会怎样？',
    'Run git - is that safe?'
  ])('讨论 Shell 执行“%s”时归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test('独立破折号后的系词从句不能被误当成 git 参数', () => {
    expectIntentKind('Run git - is that safe', 'chat');
  });

  test('无分隔符的助动词从句不能被误当成 npm 参数', () => {
    expectIntentKind('Run npm test does this modify files', 'chat');
  });

  test('疑问词起始的自然语言从句不能被误当成 node 参数', () => {
    expectIntentKind('Run node where does this write files', 'chat');
  });

  test('逗号后的情态助动词从句不能被误当成 cargo 参数', () => {
    expectIntentKind('Run cargo build, would that change outputs', 'chat');
  });

  test('短系词评价不能因只剩一个谓语 token 而被误当成 deno 参数', () => {
    expectIntentKind('Run deno is stable', 'chat');
  });

  test('疑问词直接连接实义动词时不能被误当成 python 参数', () => {
    expectIntentKind('Run python what happens next', 'chat');
  });

  test.each([
    'Run git log -1',
    'Run npm test -- --runInBand',
    'Run node where.js --mode fast',
    'Run cargo build --release',
    'Run deno task build',
    'Run python what.py next'
  ])('合法命令参数“%s”不因自然语言从句防线而被拒绝', text => {
    expectIntentKind(text, 'powershell_task');
  });

  test.each([
    '执行这条命令 node -e "console.log(\'safe?\')"',
    '运行 node --label "is that safe?"',
    '运行 .\\scripts\\build.ps1 "参数安全吗？"',
    '执行这条命令 node ".\\脚本\\构建.js"'
  ])('引号内的疑问参数与中文路径使“%s”保持 PowerShell 任务', text => {
    expectIntentKind(text, 'powershell_task');
  });

  test.each([
    'PowerShell 是什么？',
    '解释这条命令会做什么：Get-ChildItem',
    '运行 "$x=1; Get-ChildItem"',
    '执行 PowerShell "Write-Output a1 a2 a3"',
    '```powershell\nRemove-Item a.txt\n```',
    '读取 notes.txt，文件正文是：运行 PowerShell Get-ChildItem',
    '读取 notes.txt，文件正文为：执行这条命令 npm test'
  ])('命令讨论、代码块和文件正文中的命令将“%s”归为普通聊天', text => {
    expectIntentKind(text, 'chat');
  });

  test('路由结果只会落入一个能力分支', () => {
    const intents = [
      capabilityIntentRouter.route('你好'),
      capabilityIntentRouter.route('删除 a.txt'),
      capabilityIntentRouter.route('执行这条命令 npm test')
    ];

    expect(intents.map(intent => intent.kind)).toEqual([
      'chat',
      'file_task',
      'powershell_task'
    ]);
  });
});
