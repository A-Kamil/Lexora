/**
 * Case — `/dossiers/:caseId`
 * One client's file: urgency and why, what to do, documents sorted by type,
 * deadlines and the conversation. Refreshed every 10 seconds.
 */

import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnalysisPanel } from '@/components/case/AnalysisPanel';
import { LegalSourcesPanel } from '@/components/case/LegalSourcesPanel';
import { DeadlinesPanel } from '@/components/case/DeadlinesPanel';
import { DocumentsPanel } from '@/components/case/DocumentsPanel';
import { MessageThread } from '@/components/case/MessageThread';
import { UrgencyBand } from '@/components/case/UrgencyBand';
import { TopBar } from '@/components/TopBar';
import { usePolling } from '@/hooks/usePolling';
import { ApiError, fetchCase } from '@/lib/api';

function CaseView({ caseId }: { caseId: string }) {
  const load = useCallback(() => fetchCase(caseId), [caseId]);
  const { data, error } = usePolling(load);

  if (!data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <main className="page-body">
        <Link to="/dossiers" className="back-link">
          ← Mes dossiers
        </Link>
        <p
          role={error ? 'alert' : 'status'}
          style={{ color: error ? 'var(--critical)' : 'var(--ink-soft)' }}
        >
          {notFound
            ? 'Ce dossier est introuvable ou ne vous est pas attribué.'
            : error
              ? 'Impossible de charger le dossier. Nouvelle tentative dans quelques secondes.'
              : 'Chargement du dossier…'}
        </p>
      </main>
    );
  }

  const documentNames = Object.fromEntries(data.documents.map((d) => [d.id, d.name]));

  return (
    <main className="page-body">
      <Link to="/dossiers" className="back-link">
        ← Mes dossiers
      </Link>

      <header className="case-header">
        <p className="section-label">{data.title}</p>
        <h1 className="font-serif">{data.clientName}</h1>
        <p className="case-header__meta">
          Juridiction {data.jurisdiction} · langue {data.language} · fuseau {data.timezone} · avocat
          : {data.lawyerName}
        </p>
      </header>

      <div className="case-bands">
        <UrgencyBand detail={data} />
        <div className="case-grid">
          <AnalysisPanel result={data.analysis?.result ?? null} />
          <DocumentsPanel caseId={data.id} documents={data.documents} timezone={data.timezone} />
          <MessageThread
            messages={data.messages}
            timezone={data.timezone}
            documentNames={documentNames}
          />
          {(data.analysis?.legalSources?.length ?? 0) > 0 ? (
            <LegalSourcesPanel
              sources={data.analysis?.legalSources ?? []}
              audit={data.analysis?.legalAudit ?? []}
            />
          ) : null}
          <DeadlinesPanel deadlines={data.deadlines} timezone={data.timezone} />
        </div>
      </div>
    </main>
  );
}

export function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  return (
    <>
      <TopBar />
      {/* `key` resets the polled data when navigating between cases. */}
      <CaseView key={caseId} caseId={caseId ?? ''} />
    </>
  );
}
