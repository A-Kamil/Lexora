/**
 * Explicit live check (real API calls, fictional data): `pnpm --filter @lexora/ai build && node --env-file=../../.env dist/live-check.js`
 * Needs MISTRAL_API_KEY; PISTE_CLIENT_ID/PISTE_CLIENT_SECRET optional (Légifrance + Judilibre).
 */
import { analyzeCase, converse, gatherLegalContext, mistralClient, DEFAULT_MODELS } from './index.js';

const env = process.env;
const client = mistralClient(env.MISTRAL_API_KEY);
const piste = env.PISTE_CLIENT_ID && env.PISTE_CLIENT_SECRET
  ? { clientId: env.PISTE_CLIENT_ID, clientSecret: env.PISTE_CLIENT_SECRET, env: (env.PISTE_ENV === 'sandbox' ? 'sandbox' : 'prod') as 'prod' | 'sandbox' }
  : undefined;

const t0 = Date.now();
const legal = await gatherLegalContext('garde à vue droit à l\'assistance d\'un avocat', {
  mode: 'direct', codes: ['procedure_penale'], clientIdentifiers: ['Martin Exemple'], ...(piste ? { piste } : {}),
});
console.log('legal sources:', legal.sources.map((s) => s.reference));
console.log('legal audit:', legal.audit);

const result = await analyzeCase(client, {
  caseTitle: 'Fictional — Mr. X, police custody', jurisdiction: 'FR', language: 'en',
  priorMessages: [],
  trigger: { id: 'm1', role: 'client', at: new Date().toISOString(),
    text: "Hello, I'm the mother of Martin Exemple. He was arrested at 11 pm tonight and he's in police custody at the station. I don't know what to do, he asked for our lawyer." },
  documents: [], legalSources: legal.sources,
  urgencyCriteria: 'CRITICAL: a person is in police custody now or a hearing is within 24 hours. HIGH: arrest or summons in the coming days. MEDIUM: ongoing case, new information. LOW: general question.',
}, env.MISTRAL_ANALYSIS_MODEL ?? DEFAULT_MODELS.analysis);
console.log(JSON.stringify(result, null, 2));
console.log(`done in ${Date.now() - t0} ms — status ${result.status}, urgency ${result.analysis.urgency}`);

// Intake agent: first turn, then a follow-up that must not repeat the question already asked.
const now = new Date().toISOString();
const turn1 = await converse(client, { history: [{ id: 'm1', role: 'client', text: 'Bonsoir, mon fils a été arrêté ce soir, il est en garde à vue.', at: now }], documents: [] }, DEFAULT_MODELS.analysis);
console.log('agent 1:', turn1);
const turn2 = await converse(client, {
  history: [
    { id: 'm1', role: 'client', text: 'Bonsoir, mon fils a été arrêté ce soir, il est en garde à vue.', at: now },
    { id: 'a1', role: 'assistant', text: turn1, at: now },
    { id: 'm2', role: 'client', text: 'Au commissariat de Créteil, depuis 22h. Est-ce qu\'il doit parler aux policiers ?', at: now },
  ],
  documents: [],
}, DEFAULT_MODELS.analysis);
console.log('agent 2 (must not advise):', turn2);
