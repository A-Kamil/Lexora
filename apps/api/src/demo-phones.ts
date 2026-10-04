import type { MemoryStore } from '@lexora/shared/pipeline';
import type { DemoConfig } from './demo-config.js';

/**
 * Memory mode: give the seeded fictional lawyer (and optionally the seeded client) a real demo phone.
 * Anyone else who writes gets a new case (open intake). Throws (refuse to start) on an inconsistent setup.
 * Returns true if a phone was replaced.
 */
export function applyDemoPhones(store: MemoryStore, config: DemoConfig): boolean {
  const { demoClientPhone: client, demoLawyerPhone: lawyer } = config;
  if (client === undefined && lawyer === undefined) return false;
  if (lawyer === undefined) throw new Error('DEMO_CLIENT_PHONE needs DEMO_LAWYER_PHONE.');
  if (client === lawyer) throw new Error('DEMO_CLIENT_PHONE and DEMO_LAWYER_PHONE must be different.');
  // Lawyer alerts only go to allowlisted numbers.
  if (!config.allowedNumbers.has(lawyer)) throw new Error('DEMO_LAWYER_PHONE must also be listed in DEMO_ALLOWED_NUMBERS.');

  const seededClient = store.people.find((p) => p.role === 'client');
  const seededLawyer = store.people.find((p) => p.role === 'lawyer');
  if (!seededClient || !seededLawyer) throw new Error('Seeded memory store has no client or lawyer to replace.');
  seededLawyer.phoneE164 = lawyer;
  if (client !== undefined) seededClient.phoneE164 = client;
  return true;
}
