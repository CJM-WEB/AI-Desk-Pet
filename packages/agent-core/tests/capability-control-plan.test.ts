import { describe, expect, test } from 'vitest';
import {
  capabilityControlPlanSchema
} from '../src/capability-control-plan';

describe('能力控制计划协议', () => {
  test.each([
    { kind: 'chat' },
    { kind: 'agent_task' }
  ])('接受合法能力控制计划 %#', plan => {
    expect(capabilityControlPlanSchema.safeParse(plan).success).toBe(true);
  });

  test.each([
    { kind: 'chat', preferredTool: null },
    { kind: 'agent_task', preferredTool: 'read_file' },
    { kind: 'agent_task', preferredTool: 'unknown' },
    { kind: 'agent_task', preferredTool: null, absolutePath: 'C:\\secret.txt' }
  ])('拒绝额外字段或非法能力控制计划 %#', plan => {
    expect(capabilityControlPlanSchema.safeParse(plan).success).toBe(false);
  });

});
