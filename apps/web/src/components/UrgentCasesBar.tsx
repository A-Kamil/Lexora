/**
 * Global bar: stays visible on every authenticated screen while at least one
 * case is HIGH/CRITICAL or its lawyer alert may not have arrived. It is mounted
 * outside route transitions so it never blinks away during navigation.
 */

import { Link } from 'react-router-dom';
import { ESCALATION, URGENCY, isUrgent } from '@/lib/legal';
import { useCases } from '@/state/useCases';
import { UrgencyTag } from './UrgencyTag';

export function UrgentCasesBar() {
  const { data } = useCases();
  if (!data) return null;

  const open = data.cases.filter((c) => c.status === 'open');
  const urgent = open
    .filter((c) => isUrgent(c.urgency))
    .sort((a, b) => URGENCY[b.urgency].rank - URGENCY[a.urgency].rank);
  const unreachable = open.filter(
    (c) => c.escalationStatus !== null && ESCALATION[c.escalationStatus].attention,
  );

  const top = urgent[0];
  if (!top) return null;

  const critical = top.urgency === 'CRITICAL';
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
        background: critical ? 'var(--critical-pale)' : 'var(--warning-pale)',
        color: critical ? 'var(--critical)' : 'var(--warning)',
        borderBottom: `1px solid ${critical ? 'var(--critical)' : 'var(--warning)'}`,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontWeight: 600 }}>
        <UrgencyTag urgency={top.urgency} showLabel={false} />
        {urgent.length === 1 ? '1 dossier urgent' : `${urgent.length} dossiers urgents`}
        <span style={{ fontWeight: 400 }}>
          — {top.clientName} : {top.issue}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {unreachable.length > 0 ? (
          <span style={{ fontSize: 14 }}>
            {unreachable.length} alerte{unreachable.length > 1 ? 's' : ''} WhatsApp à vérifier
          </span>
        ) : null}
        <Link to={`/dossiers/${top.id}`} className="toolbar-btn">
          Ouvrir le dossier
        </Link>
      </span>
    </div>
  );
}
