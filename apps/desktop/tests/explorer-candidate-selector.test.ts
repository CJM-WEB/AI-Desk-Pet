import { describe, expect, test } from 'vitest';
import {
  selectExplorerCandidate,
  type ExplorerCandidateFrame,
  type ExplorerCandidateSelection
} from '../src/main/habitat/explorer-candidate-selector';

const NOW = 10_000;

function frame(
  overrides: Partial<ExplorerCandidateFrame> = {}
): ExplorerCandidateFrame {
  return {
    instanceId: 'instance-current',
    sequence: 10,
    foregroundHwnd: '18446744073709551615',
    now: NOW,
    destroyed: false,
    candidates: [{
      candidateId: 'candidate-1',
      hwnd: '18446744073709551615',
      activationSequence: 20,
      observedAt: NOW - 10,
      expiresAt: NOW + 1_000,
      foreground: true,
      minimized: false,
      search: false,
      ambiguous: false,
      match: { status: 'matched', directoryId: 'directory-1' }
    }],
    ...overrides
  };
}

function expectHidden(selection: ExplorerCandidateSelection): void {
  expect(selection).toEqual({ status: 'hidden' });
}

describe('selectExplorerCandidate', () => {
  test.each([
    ['非前台', { foreground: false }],
    ['最小化', { minimized: true }],
    ['搜索结果', { search: true }],
    ['事实歧义', { ambiguous: true }],
    ['身份未匹配', { match: { status: 'hidden' } }],
    ['已经过期', { expiresAt: NOW }],
    ['未来时间戳', { observedAt: NOW + 1 }],
    ['非规范 HWND', { hwnd: '018446744073709551615' }]
  ] as const)('%s 候选保持隐藏', (_name, candidatePatch) => {
    const base = frame();
    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: {
        ...base,
        candidates: [{ ...base.candidates[0]!, ...candidatePatch }]
      }
    }));
  });

  test('只选择当前前台 HWND 且全程保留十进制字符串精度', () => {
    const selection = selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: frame()
    });

    expect(selection).toEqual({
      status: 'selected',
      binding: {
        instanceId: 'instance-current',
        hwnd: '18446744073709551615',
        sequence: 10,
        activationSequence: 20,
        directoryId: 'directory-1'
      }
    });
    if (selection.status === 'selected') {
      expect(typeof selection.binding.hwnd).toBe('string');
    }
  });

  test('同一路径多窗口与同 HWND 多标签按最大激活序号选择', () => {
    const base = frame();
    const selection = selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: {
        ...base,
        candidates: [
          { ...base.candidates[0]!, candidateId: 'window-old', hwnd: '101', activationSequence: 10 },
          { ...base.candidates[0]!, candidateId: 'tab-old', activationSequence: 30 },
          { ...base.candidates[0]!, candidateId: 'tab-active', activationSequence: 31 }
        ]
      }
    });

    expect(selection.status).toBe('selected');
    if (selection.status === 'selected') {
      expect(selection.binding).toMatchObject({
        hwnd: '18446744073709551615',
        activationSequence: 31,
        directoryId: 'directory-1'
      });
    }
  });

  test('最大激活序号平序或候选事实冲突时失败关闭', () => {
    const base = frame();
    const tied = [
      { ...base.candidates[0]!, candidateId: 'tab-a', activationSequence: 31 },
      { ...base.candidates[0]!, candidateId: 'tab-b', activationSequence: 31 }
    ];
    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: { ...base, candidates: tied }
    }));

    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: {
        ...base,
        candidates: [
          { ...base.candidates[0]!, candidateId: 'same-fact' },
          {
            ...base.candidates[0]!,
            candidateId: 'same-fact',
            activationSequence: 21,
            match: { status: 'matched', directoryId: 'directory-2' }
          }
        ]
      }
    }));
  });

  test('事件倒序、旧实例重放、实例销毁与前台 HWND 变化立即撤销绑定', () => {
    const selected = selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      frame: frame()
    });
    expect(selected.status).toBe('selected');
    if (selected.status !== 'selected') throw new Error('测试前置选择失败');

    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      previous: selected.binding,
      frame: frame({ sequence: 9 })
    }));
    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      previous: selected.binding,
      frame: frame({ instanceId: 'instance-old', sequence: 11 })
    }));
    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      previous: selected.binding,
      frame: frame({ destroyed: true, sequence: 11 })
    }));
    expectHidden(selectExplorerCandidate({
      activeInstanceId: 'instance-current',
      previous: selected.binding,
      frame: frame({ foregroundHwnd: '202', sequence: 11 })
    }));
  });
});
