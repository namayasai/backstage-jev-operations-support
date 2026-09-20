import { describe, expect, it } from 'vitest';
import { defaultUnownedOwnerValues, isUnownedOwner } from './index';

describe('isUnownedOwner', () => {
  it('treats missing or blank owner as unowned regardless of the configured list', () => {
    expect(isUnownedOwner('', [])).toBe(true);
    expect(isUnownedOwner('   ', [])).toBe(true);
  });

  it('matches every default unowned form, case-insensitively', () => {
    expect(isUnownedOwner('unknown')).toBe(true);
    expect(isUnownedOwner('Unknown')).toBe(true);
    expect(isUnownedOwner('GUESTS')).toBe(true);
    expect(isUnownedOwner('group:default/guests')).toBe(true);
    expect(isUnownedOwner('Group:Default/Guests')).toBe(true);
  });

  it('normalises a bare group name against a configured ref form', () => {
    // "guests" (no kind/namespace) normalises to group:default/guests, which is in the
    // default list — this is the same normalisation a short-form spec.owner: guests uses.
    expect(isUnownedOwner('guests', defaultUnownedOwnerValues)).toBe(true);
  });

  it('does not treat a real, existing-looking owner as unowned', () => {
    expect(isUnownedOwner('group:default/platform')).toBe(false);
    expect(isUnownedOwner('user:default/alice')).toBe(false);
  });

  it('does not throw on a value that does not parse as an entity ref', () => {
    expect(isUnownedOwner('not a valid ref!!')).toBe(false);
  });

  it('respects a custom unownedValues list instead of the default', () => {
    expect(isUnownedOwner('team-nobody', ['team-nobody'])).toBe(true);
    expect(isUnownedOwner('unknown', ['team-nobody'])).toBe(false);
  });
});
