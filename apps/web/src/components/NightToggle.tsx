import { useNightMode } from '@/hooks/useNightMode';

export function NightToggle() {
  const { night, toggle } = useNightMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={night}
      className="toolbar-btn"
      title={night ? 'Passer en mode jour' : 'Passer en mode nuit'}
    >
      {night ? 'Mode jour' : 'Mode nuit'}
    </button>
  );
}
