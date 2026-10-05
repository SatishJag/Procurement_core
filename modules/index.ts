import { Platform, type Seed } from '../core/kernel';
import * as contracts from './contracts';

// The module registry. A new capability = one file in modules/, one export
// line here, and its event subscriptions in createPlatform.
export * as awards from './awards';
export * as contracts from './contracts';
export * as evaluation from './evaluation';
export * as insight from './insight';
export * as intake from './intake';
export * as payables from './payables';
export * as planning from './planning';
export * as reporting from './reporting';
export * as sourcing from './sourcing';
export * as suppliers from './suppliers';
export { Platform, type Seed };

export function createPlatform(seed: Seed, clock?: () => string) {
  const p = new Platform(seed, clock);
  p.on('award.approved', contracts.draftFromAward);
  return p;
}
