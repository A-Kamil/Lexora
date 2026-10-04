/** Annuaire des entreprises (api.gouv.fr, public, no key): identify the employer / opposing party. */
export interface Company { siren: string; name: string; address: string | null; activity: string | null; status: string | null; collectiveAgreements: string[] }

export async function findCompany(name: string, n = 3): Promise<Company[]> {
  const res = await fetch(`https://recherche-entreprises.api.gouv.fr/search?${new URLSearchParams({ q: name, per_page: String(n) })}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`recherche-entreprises ${res.status}`);
  const j = (await res.json()) as { results?: Array<Record<string, any>> };
  return (j.results ?? []).slice(0, n).map((e) => ({
    siren: String(e.siren), name: String(e.nom_complet ?? ''), address: e.siege?.adresse ?? null,
    activity: e.activite_principale ?? null, status: e.etat_administratif ?? null, collectiveAgreements: e.complements?.liste_idcc ?? [],
  }));
}
