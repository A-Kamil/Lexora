/**
 * Login — `/connexion`
 * Design-only form: nothing is checked or sent anywhere. Any input signs in the
 * fictional demo lawyer (see `lib/session.ts`).
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { NightToggle } from '@/components/NightToggle';
import { startSession } from '@/lib/session';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    window.setTimeout(() => {
      startSession();
      navigate('/dossiers');
    }, 600);
  };

  return (
    <main className="login-page">
      <header className="login-page__top">
        <Link to="/" className="back-link" style={{ margin: 0 }}>
          ← Accueil
        </Link>
        <NightToggle />
      </header>

      <section className="login-card" aria-labelledby="login-title">
        <Logo size={40} />
        <h1 id="login-title" className="font-serif login-card__title">
          Connexion
        </h1>
        <p className="login-card__sub">Accédez à l’espace de votre cabinet.</p>

        <form onSubmit={submit} className="login-form" noValidate>
          <label className="login-label">
            Adresse e-mail
            <input
              className="login-field"
              type="email"
              autoComplete="username"
              placeholder="prenom.nom@cabinet.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pending}
            />
          </label>

          <label className="login-label">
            Mot de passe
            <input
              className="login-field"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
            />
          </label>

          <div className="login-row">
            <label className="login-check">
              <input type="checkbox" defaultChecked /> Rester connecté
            </label>
            <span className="login-link">Mot de passe oublié ?</span>
          </div>

          <button type="submit" className="login-submit" disabled={pending}>
            {pending ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>

        <p className="login-card__note">
          Démonstration : n’importe quels identifiants ouvrent l’espace de Me John Smith.
        </p>
      </section>
    </main>
  );
}
