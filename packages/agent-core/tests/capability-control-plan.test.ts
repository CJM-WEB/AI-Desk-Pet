import { describe, expect, test } from 'vitest';
import {
  agentPlanningToolSchema,
  capabilityControlPlanSchema
} from '../src/capability-control-plan';

describe('能力控制计划协议', () => {
  test.each([
    { kind: 'chat' },
    { kind: 'agent_task', preferredTool: null },
    { kind: 'agent_task', preferredTool: 'create_file' },
    { kind: 'agent_task', preferredTool: 'powershell' }
  ])('接受合法能力控制计划 %#', plan => {
    expect(capabilityControlPlanSchema.safeParse(plan).success).toBe(true);
  });

  test.each([
    { kind: 'chat', preferredTool: null },
    { kind: 'agent_task' },
    { kind: 'agent_task', preferredTool: 'unknown' },
    { kind: 'agent_task', preferredTool: null, absolutePath: 'C:\\secret.txt' }
  ])('拒绝额外字段或非法能力控制计划 %#', plan => {
    expect(capabilityControlPlanSchema.safeParse(plan).success).toBe(false);
  });

  test('首轮工具枚举只包含现有文件规划工具和受控 PowerShell', () => {
    expect(agentPlanningToolSchema.safeParse('read_file').success).toBe(true);
    expect(agentPlanningToolSchema.safeParse('powershell').success).toBe(true);
    expect(agentPlanningToolSchema.safeParse('shell').success).toBe(false);
    expect(agentPlanningToolSchema.safeParse('builtin.files.read_file').success).toBe(false);
  });
});
