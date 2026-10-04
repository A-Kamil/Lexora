/** OAuth client-credentials for PISTE (Légifrance, Judilibre). Token cached until expiry. */
export interface PisteConfig { clientId: string; clientSecret: string; env?: 'prod' | 'sandbox' }

const HOSTS = {
  prod: { oauth: 'https://oauth.piste.gouv.fr/api/oauth/token', api: 'https://api.piste.gouv.fr' },
  sandbox: { oauth: 'https://sandbox-oauth.piste.gouv.fr/api/oauth/token', api: 'https://sandbox-api.piste.gouv.fr' },
};

export class Piste {
  private token: { value: string; exp: number } | null = null;
  constructor(private readonly cfg: PisteConfig) {}

  private get hosts() { return HOSTS[this.cfg.env ?? 'prod']; }

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    const res = await fetch(this.hosts.oauth, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: 'openid' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`PISTE OAuth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.hosts.api + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.bearer()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`PISTE ${path} ${res.status}`);
    return (await res.json()) as T;
  }

  async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.hosts.api}${path}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${await this.bearer()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`PISTE ${path} ${res.status}`);
    return (await res.json()) as T;
  }
}
