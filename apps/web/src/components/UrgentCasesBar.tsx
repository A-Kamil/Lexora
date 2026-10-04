/**
 * Global bar: stays visible on every authenticated screen while at least one
 * case is HIGH/CRITICAL or its lawyer alert may not have arrived. It is mounted
 * outside route transitions so it never blinks away during navigation.
 */

import { Link } from 'react-router-dom';
import { ESCALATION, URGENCY, compactText, isUrgent } from '@/lib/legal';
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
      className="urgent-cases-bar"
      style={{
        background: critical ? 'var(--critical-pale)' : 'var(--warning-pale)',
        color: critical ? 'var(--critical)' : 'var(--warning)',
        borderBottom: `1px solid ${critical ? 'var(--critical)' : 'var(--warning)'}`,
      }}
    >
      <span className="urgent-cases-bar__summary">
        <UrgencyTag urgency={top.urgency} showLabel={false} />
        <span className="urgent-cases-bar__count">
          {urgent.length === 1 ? '1 dossier urgent' : `${urgent.length} dossiers urgents`}
        </span>
        <span className="urgent-cases-bar__issue">
          — {top.clientName} : {compactText(top.issue, 110)}
        </span>
      </span>
      <span className="urgent-cases-bar__actions">
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
