import type { MemoryStore } from '@lexora/shared/pipeline';
import type { DemoConfig } from './demo-config.js';

/**
 * Memory mode: replace the phones of the seeded fictional client and lawyer by real demo phones.
 * Throws (refuse to start) if only one is set, if both are equal, or if one is not in DEMO_ALLOWED_NUMBERS.
 * Returns true if the phones were replaced.
 */
export function applyDemoPhones(store: MemoryStore, config: DemoConfig): boolean {
  const { demoClientPhone: client, demoLawyerPhone: lawyer } = config;
  if (client === undefined && lawyer === undefined) return false;
  if (client === undefined || lawyer === undefined) {
    throw new Error('DEMO_CLIENT_PHONE and DEMO_LAWYER_PHONE must be set together.');
  }
  if (client === lawyer) throw new Error('DEMO_CLIENT_PHONE and DEMO_LAWYER_PHONE must be different.');
  for (const [name, phone] of [['DEMO_CLIENT_PHONE', client], ['DEMO_LAWYER_PHONE', lawyer]] as const) {
    if (!config.allowedNumbers.has(phone)) throw new Error(`${name} must also be listed in DEMO_ALLOWED_NUMBERS.`);
  }

  const seededClient = store.people.find((p) => p.role === 'client');
  const seededLawyer = store.people.find((p) => p.role === 'lawyer');
  if (!seededClient || !seededLawyer) throw new Error('Seeded memory store has no client or lawyer to replace.');
  seededClient.phoneE164 = client;
  seededLawyer.phoneE164 = lawyer;
  return true;
}
