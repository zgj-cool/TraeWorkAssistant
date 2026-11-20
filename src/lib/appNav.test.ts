import { describe, expect, it } from 'vitest';
import { resolveAppSwitchView } from './appNav';

describe('resolveAppSwitchView', () => {
  it('切换应用保持同一功能页（积分看板 / 账号 / 签到 / 资源调度 / 环境配置）', () => {
    expect(resolveAppSwitchView('credits', 'buddy')).toBe('buddy-credits');
    expect(resolveAppSwitchView('buddy-credits', 'qoder')).toBe('qoder-credits');
    expect(resolveAppSwitchView('qoder-credits', 'trae')).toBe('credits');
    expect(resolveAppSwitchView('accounts', 'buddy')).toBe('buddy-accounts');
    expect(resolveAppSwitchView('buddy-checkin', 'trae')).toBe('checkin');
    expect(resolveAppSwitchView('api-service', 'qoder')).toBe('qoder-api-service');
    expect(resolveAppSwitchView('buddy-settings', 'buddy-ai')).toBe('buddyai-settings');
  });

  it('豆包额度看板与积分看板视为同一功能页（双向）', () => {
    expect(resolveAppSwitchView('credits', 'doubao')).toBe('doubao-quota');
    expect(resolveAppSwitchView('doubao-quota', 'trae')).toBe('credits');
  });

  it('当前为跨平台总览时进入目标应用概览页', () => {
    expect(resolveAppSwitchView('overview', 'trae')).toBe('dashboard');
    expect(resolveAppSwitchView('overview', 'buddy')).toBe('buddy-overview');
    expect(resolveAppSwitchView('overview', 'doubao')).toBe('doubao-overview');
  });

  it('无功能页归属或目标应用缺该页时回落目标首页', () => {
    // logs 不属于任何应用功能页
    expect(resolveAppSwitchView('logs', 'buddy')).toBe('buddy-overview');
    // 豆包没有资源调度页
    expect(resolveAppSwitchView('api-service', 'doubao')).toBe('doubao-overview');
  });
});
