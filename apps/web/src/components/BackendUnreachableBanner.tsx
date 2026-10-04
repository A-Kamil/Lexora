/** Shown when the data source cannot be reached: the screen may be out of date. */

interface Props {
  onRetry: () => void;
  onDismiss: () => void;
}

export function BackendUnreachableBanner({ onRetry, onDismiss }: Props) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '12px 48px',
        background: 'var(--warning-pale)',
        color: 'var(--warning)',
        borderBottom: '1px solid var(--warning)',
        fontSize: 15,
        fontWeight: 500,
      }}
    >
      <span>◆ Données indisponibles — les dossiers affichés peuvent ne pas être à jour.</span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="toolbar-btn" onClick={onRetry}>
          Réessayer
        </button>
        <button type="button" className="toolbar-btn" onClick={onDismiss}>
          Masquer
        </button>
      </span>
    </div>
  );
}
