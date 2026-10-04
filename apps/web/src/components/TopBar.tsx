import { Link, useNavigate } from 'react-router-dom';
import { Clock } from './Clock';
import { Logo } from './Logo';
import { NightToggle } from './NightToggle';
import { clearSession, getSession } from '@/lib/session';

export function TopBar() {
  const navigate = useNavigate();
  const session = getSession();

  const signOut = () => {
    clearSession();
    navigate('/', { replace: true });
  };

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
        padding: '20px 48px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <Link to="/dossiers" aria-label="Lexora — liste des dossiers">
        <Logo size={32} />
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <Clock />
        {session ? (
          <span style={{ fontSize: 14, color: 'var(--ink-soft)' }}>{session.lawyerName}</span>
        ) : null}
        <NightToggle />
        <button type="button" onClick={signOut} className="toolbar-btn">
          Quitter
        </button>
      </div>
    </header>
  );
}
