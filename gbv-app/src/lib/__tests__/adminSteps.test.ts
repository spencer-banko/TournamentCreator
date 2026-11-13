import { describe, it, expect } from 'vitest';
import { stepState, nextStep, stepForRoute, EMPTY_STATS, type ProgressStats } from '../adminSteps';

const s = (over: Partial<ProgressStats>): ProgressStats => ({ ...EMPTY_STATS, hasTournament: true, ...over });

describe('stepState', () => {
  it('starts with only setup done', () => {
    expect(stepState('setup', s({})).status).toBe('done');
    expect(stepState('teams', s({})).status).toBe('todo');
    expect(stepState('setup', EMPTY_STATS).status).toBe('todo');
  });

  it('flags unassigned teams on pools', () => {
    expect(stepState('pools', s({ teams: 12, pools: 3, teamsInPool: 10 }))).toEqual({ status: 'attention', hint: '2 unassigned' });
    expect(stepState('pools', s({ teams: 12, pools: 3, teamsInPool: 12 }))).toEqual({ status: 'done', hint: '3 pools' });
  });

  it('tracks pool schedule progress and setup issues', () => {
    expect(stepState('schedule', s({ pools: 3, scheduleIssues: 1 })).status).toBe('attention');
    expect(stepState('schedule', s({ poolMatches: 18, poolScored: 4 })).hint).toBe('4/18 scored');
    expect(stepState('schedule', s({ poolMatches: 18, poolScored: 18 })).status).toBe('done');
  });

  it('tracks bracket completion', () => {
    expect(stepState('brackets', s({ bracketMatches: 7, bracketOpen: 3 })).hint).toBe('3 matches left');
    expect(stepState('brackets', s({ bracketMatches: 7, bracketOpen: 0 })).status).toBe('done');
  });
});

describe('nextStep / stepForRoute', () => {
  it('continues at the first unfinished step', () => {
    expect(nextStep(s({ teams: 12 })).id).toBe('pools');
    expect(nextStep(s({ teams: 12, pools: 3, teamsInPool: 12, poolMatches: 6, poolScored: 6, bracketMatches: 3 })).id).toBe('brackets');
  });
  it('maps routes to steps', () => {
    expect(stepForRoute('admin-pools-seeds')?.id).toBe('pools');
    expect(stepForRoute('admin-dashboard')).toBeNull();
  });
});
