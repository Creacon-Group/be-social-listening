import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  ROLE_PRESETS,
} from './permissions.js';

describe('effectivePermissions', () => {
  it('gives ADMIN and SUPERADMIN everything, whatever is stored', () => {
    expect(effectivePermissions('ADMIN', [])).toEqual(ALL_PERMISSIONS);
    expect(effectivePermissions('SUPERADMIN', ['overview.view'])).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it('falls back to the role preset when nothing is stored', () => {
    expect(effectivePermissions('VIEWER', null)).toEqual(ROLE_PRESETS.VIEWER);
    expect(effectivePermissions('ANALYST', null)).toContain('data.upload');
    expect(effectivePermissions('VIEWER', null)).not.toContain('data.upload');
  });

  it('uses stored keys and drops unknown ones', () => {
    expect(
      effectivePermissions('VIEWER', ['mentions.view', 'nope', 7]),
    ).toEqual(['mentions.view']);
    expect(effectivePermissions('ANALYST', [])).toEqual([]);
  });
});
