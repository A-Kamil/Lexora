/**
 * Landing — `/`
 * Sober entry screen. The wordmark cycles through the product promise with a
 * single horizontal fade. Entering starts the demo session (no authentication).
 */

import { useEffect, useState } from 'react';
import type { Variants } from 'framer-motion';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { NightToggle } from '@/components/NightToggle';
import { startSession } from '@/lib/session';

const FADE_HORIZONTAL: Variants = {
  initial: { opacity: 0, x: '-6%' },
  animate: { opacity: 1, x: '0%', transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, x: '6%', transition: { duration: 0.6, ease: [0.55, 0, 0.7, 0.4] } },
};

const HERO_PHRASES: readonly string[] = [
  'Lexora',
  'Chaque dossier, du premier regard.',
  'L’urgence d’abord.',
  'Toutes les pièces, bien rangées.',
];

const ROTATION_MS = 5000;

export function LandingPage() {
  const navigate = useNavigate();
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setPhraseIndex((i) => (i + 1) % HERO_PHRASES.length);
    }, ROTATION_MS);
    return () => window.clearInterval(id);
  }, []);

  const enter = () => {
    startSession();
    navigate('/dossiers');
  };

  return (
    <main
      style={{
        minHeight: '100svh',
        background: 'var(--bg)',
        color: 'var(--ink)',
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 48px',
        boxSizing: 'border-box',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <NightToggle />
      </header>

      <section
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 56,
          textAlign: 'center',
        }}
      >
        <div style={{ minHeight: 160, display: 'flex', alignItems: 'center' }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={phraseIndex}
              variants={FADE_HORIZONTAL}
              initial="initial"
              animate="animate"
              exit="exit"
              className="font-serif"
              style={{
                margin: 0,
                fontSize: 'clamp(56px, 9vw, 120px)',
                lineHeight: 1.02,
                letterSpacing: '-0.03em',
                fontWeight: 400,
              }}
            >
              {HERO_PHRASES[phraseIndex]}
            </motion.h1>
          </AnimatePresence>
        </div>

        <p style={{ maxWidth: 560, margin: 0, color: 'var(--ink-soft)', fontSize: 19 }}>
          Les messages et documents de vos clients, triés par urgence et classés par dossier, pour
          décider vite.
        </p>

        <button type="button" className="enter-btn" onClick={enter}>
          <span className="enter-btn-label enter-btn-label-idle">Accéder à mes dossiers</span>
          <span className="enter-btn-label enter-btn-label-hover" aria-hidden="true">
            Entrer →
          </span>
        </button>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 14, color: 'var(--ink-muted)' }}>
        Démonstration — données fictives. Aide à la décision : ne constitue pas un avis juridique.
      </footer>
    </main>
  );
}
