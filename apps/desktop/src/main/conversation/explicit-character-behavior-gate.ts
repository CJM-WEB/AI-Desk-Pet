import type {
  ExplicitBehaviorDirective,
  PreparedBehaviorPrompt
} from '../characters/character-behavior-director';

type ParsedBehaviorPrompt = Pick<
  PreparedBehaviorPrompt,
  'capabilityText' | 'explicitDirective'
>;

const 引用或代码开头 = /^(?:>|[`'"“”‘’])/u;
const 文件移动否定 = /^(?:别|不要|无需)移动(?:这个|该|我的)?文件/u;
const 中文组合分隔 = /^(?:\s*(?:并且?|然后|再)\s*)/u;
const 英文组合分隔 = /^(?:\s*(?:and|then)\s+)/iu;

const 方向表 = Object.freeze({
  左: 'left',
  右: 'right',
  上: 'up',
  下: 'down'
} as const);
const 英文方向表 = Object.freeze({
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down'
} as const);
const 区域表 = Object.freeze({
  左边: 'left',
  右边: 'right',
  顶部: 'top',
  上边: 'top',
  底部: 'bottom',
  下边: 'bottom',
  左上角: 'top_left',
  右上角: 'top_right',
  左下角: 'bottom_left',
  右下角: 'bottom_right'
} as const);

/**
 * 只识别用户消息开头的有限命令语法；引用、代码和讨论文本没有行为权限。
 * 返回的剩余文本仍须交给既有能力路由，Gate 自身不持有文件或命令端口。
 */
export function parseExplicitCharacterBehavior(text: string): ParsedBehaviorPrompt | null {
  const normalized = text.trim();
  if (!normalized || 引用或代码开头.test(normalized) || 文件移动否定.test(normalized)) {
    return null;
  }

  const parsed = parseChinese(normalized) ?? parseEnglish(normalized);
  if (!parsed) return null;
  if (!hasDirectiveBoundary(normalized.slice(parsed.consumed))) return null;
  return {
    capabilityText: remainingCapabilityText(normalized, parsed.consumed),
    explicitDirective: parsed.directive
  };
}

type ParsedDirective = Readonly<{
  consumed: number;
  directive: ExplicitBehaviorDirective;
}>;

function parseChinese(text: string): ParsedDirective | null {
  const stop = /^(?:请)?(?:你)?(?:停下|停止不动|别走了|不要走了|别动了|不要动了|静止不动|保持静止|不要再动|别乱跑)/u.exec(text);
  if (stop) return { consumed: stop[0].length, directive: { kind: 'stop_movement' } };

  const continuous = /^(?:请)?(?:保持运动|一直走|继续跑)/u.exec(text);
  if (continuous) return { consumed: continuous[0].length, directive: { kind: 'continuous_movement' } };

  const resume = /^(?:请)?(?:恢复活动|恢复移动|可以动了|继续活动|继续走)/u.exec(text);
  if (resume) return { consumed: resume[0].length, directive: { kind: 'resume_movement' } };

  const region = /^(?:请)?(?:去|走到|移动到)(?:屏幕)?(左上角|右上角|左下角|右下角|左边|右边|顶部|上边|底部|下边)/u.exec(text);
  if (region?.[1]) {
    return {
      consumed: region[0].length,
      directive: {
        kind: 'move',
        motion: { kind: 'region', region: 区域表[region[1] as keyof typeof 区域表] }
      }
    };
  }

  const relative = /^(?:请)?(?:向|往)(左|右|上|下)(?:走|移动)?(远一点|远些|一点|一些|近一点|中等)?/u.exec(text);
  if (relative?.[1]) {
    const distanceText = relative[2] ?? '';
    const distance = distanceText.startsWith('远')
      ? 'far'
      : distanceText === '中等'
        ? 'medium'
        : distanceText.length > 0
          ? 'near'
          : 'medium';
    return {
      consumed: relative[0].length,
      directive: {
        kind: 'move',
        motion: {
          kind: 'relative',
          direction: 方向表[relative[1] as keyof typeof 方向表],
          distance
        }
      }
    };
  }

  const play = /^(?:请)?(?:做一个|播放|表演)\s*(.{1,120}?)\s*动作/u.exec(text);
  const actionName = play?.[1] ? validExplicitActionName(play[1]) : null;
  if (play && actionName) {
    return {
      consumed: play[0].length,
      directive: {
        kind: 'play',
        target: { kind: 'action_name', name: actionName }
      }
    };
  }

  const farWander = /^(?:请你?|你能)?(?:跑|走|移动)(?:得)?(?:远一点|远些)/u.exec(text);
  if (farWander) {
    return {
      consumed: farWander[0].length,
      directive: { kind: 'move', motion: { kind: 'wander', scope: 'work_area', distance: 'far' } }
    };
  }

  const wander = /^(?:请你?|你能|你)?(?:开始运动|活动一下|移动一下|运动一下|跑一跑|跑一下|动一下|移动|跑步|走一走|走走|散散步|到处走走|运动|动|跑)(?:吗)?/u.exec(text);
  return wander
    ? {
        consumed: wander[0].length,
        directive: { kind: 'move', motion: { kind: 'wander', scope: 'short' } }
      }
    : null;
}

function parseEnglish(text: string): ParsedDirective | null {
  const stop = /^(?:please\s+)?stop(?:\s+(?:moving|walking))?(?=$|[,.!?]|\s+(?:and|then)\b)/iu.exec(text);
  if (stop) return { consumed: stop[0].length, directive: { kind: 'stop_movement' } };

  const resume = /^(?:please\s+)?(?:resume|start|continue)(?:\s+(?:moving|walking))?(?=$|[,.!?]|\s+(?:and|then)\b)/iu.exec(text);
  if (resume) return { consumed: resume[0].length, directive: { kind: 'resume_movement' } };

  const region = /^(?:please\s+)?(?:go|walk|move)\s+to\s+(?:the\s+)?(top left|top right|bottom left|bottom right|left|right|top|bottom)/iu.exec(text);
  if (region?.[1]) {
    const normalizedRegion = region[1].toLowerCase().replace(' ', '_') as
      'left' | 'right' | 'top' | 'bottom' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
    return {
      consumed: region[0].length,
      directive: { kind: 'move', motion: { kind: 'region', region: normalizedRegion } }
    };
  }

  const relative = /^(?:please\s+)?(?:move|walk|go)\s+(left|right|up|down)(?:\s+(a little|slightly|near|medium|far|a lot))?/iu.exec(text);
  if (relative?.[1]) {
    const distanceText = relative[2]?.toLowerCase() ?? '';
    const distance = distanceText === 'far' || distanceText === 'a lot'
      ? 'far'
      : distanceText === 'medium' || distanceText.length === 0
        ? 'medium'
        : 'near';
    return {
      consumed: relative[0].length,
      directive: {
        kind: 'move',
        motion: {
          kind: 'relative',
          direction: 英文方向表[relative[1].toLowerCase() as keyof typeof 英文方向表],
          distance
        }
      }
    };
  }

  const play = /^(?:please\s+)?(?:(?:play|perform)\s+|do\s+(?:an?\s+)?)(.{1,120}?)\s+(?:animation|action)/iu.exec(text);
  const actionName = play?.[1] ? validExplicitActionName(play[1]) : null;
  if (play && actionName) {
    return {
      consumed: play[0].length,
      directive: {
        kind: 'play',
        target: { kind: 'action_name', name: actionName }
      }
    };
  }

  const wander = /^(?:please\s+)?(?:walk|move)\s+around/iu.exec(text);
  return wander
    ? {
        consumed: wander[0].length,
        directive: { kind: 'move', motion: { kind: 'wander', scope: 'short' } }
      }
    : null;
}

/** 动作命令只接收公开短名称，拒绝引用边界、代码和任何路径形态。 */
function validExplicitActionName(value: string): string | null {
  const name = value.trim();
  if (!name || Array.from(name).length > 120) return null;
  if (/[\\/`'"“”‘’「」『』<>]/u.test(name) || /^[a-z]:/iu.test(name)) return null;
  return name;
}

function remainingCapabilityText(original: string, consumed: number): string {
  const remaining = original.slice(consumed);
  const separator = 中文组合分隔.exec(remaining) ?? 英文组合分隔.exec(remaining);
  if (!separator) return original;
  const capabilityText = remaining.slice(separator[0].length).trim();
  return capabilityText || original;
}

function hasDirectiveBoundary(remaining: string): boolean {
  const normalized = remaining.trimStart();
  return normalized.length === 0
    || /^[，。！？,.!?]/u.test(normalized)
    || 中文组合分隔.test(remaining)
    || 英文组合分隔.test(remaining);
}
