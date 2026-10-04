import { useEffect, useState } from 'react';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  DOCUMENT_STATUS_LABEL,
  formatBytes,
  formatDate,
  formatDateTime,
} from '@/lib/legal';
import { documentContentUrl } from '@/lib/api';
import type { CaseDocument, DocumentCategory } from '@/types/lexora';

function statusClass(status: CaseDocument['status']): string {
  if (status === 'ready') return 'chip chip--ok';
  if (status === 'failed' || status === 'rejected') return 'chip chip--bad';
  return 'chip chip--warn';
}

function DocumentModal({
  document: d,
  caseId,
  timezone,
  onClose,
}: {
  document: CaseDocument;
  caseId: string;
  timezone: string;
  onClose: () => void;
}) {
  const originalUrl = documentContentUrl(caseId, d.id);
  const canOpenOriginal = d.status === 'ready';
  const isPdf = d.mimeType === 'application/pdf';
  const isImage = /^image\/(gif|jpeg|png|webp)$/.test(d.mimeType);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="modal-curtain" onClick={onClose} aria-hidden="true" />
      <div className="modal-wrap">
        <div className="modal-panel" role="dialog" aria-modal="true" aria-label={d.name}>
          <div className="modal-head">
            <div>
              <p className="section-label">{CATEGORY_LABEL[d.category]}</p>
              <h2 className="font-serif" style={{ margin: 0, fontSize: 34, fontWeight: 400 }}>
                {d.name}
              </h2>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-soft)', fontSize: 15 }}>
                Reçu le {formatDateTime(d.receivedAt, timezone)} · {formatBytes(d.byteSize)} ·{' '}
                {d.mimeType}
              </p>
            </div>
            <div className="modal-actions">
              {canOpenOriginal ? (
                <a className="toolbar-btn" href={originalUrl} target="_blank" rel="noreferrer">
                  Ouvrir l’original
                </a>
              ) : null}
              <button type="button" className="toolbar-btn" onClick={onClose} autoFocus>
                Fermer
              </button>
            </div>
          </div>

          <div className="modal-body">
            <span className={statusClass(d.status)}>{DOCUMENT_STATUS_LABEL[d.status]}</span>
            {d.errorReason ? <p style={{ color: 'var(--critical)' }}>▲ {d.errorReason}</p> : null}

            {canOpenOriginal && isPdf ? (
              <iframe
                className="document-preview"
                src={originalUrl}
                title={`Original — ${d.name}`}
              />
            ) : null}

            {canOpenOriginal && isImage ? (
              <img
                className="document-preview document-preview--image"
                src={originalUrl}
                alt={d.name}
              />
            ) : null}

            {canOpenOriginal && !isPdf && !isImage ? (
              <p>
                <a className="toolbar-btn" href={originalUrl}>
                  Télécharger l’original
                </a>
              </p>
            ) : null}

            {d.summary ? (
              <>
                <h3 className="font-serif sub-title">Résumé</h3>
                <p style={{ margin: 0 }}>{d.summary}</p>
              </>
            ) : null}

            {d.dateMentions.length > 0 ? (
              <>
                <h3 className="font-serif sub-title">Dates relevées (non vérifiées)</h3>
                <ul className="plain-list">
                  {d.dateMentions.map((m) => (
                    <li key={m.text}>
                      « {m.text} »{' '}
                      {m.isoDate ? (
                        <span style={{ color: 'var(--ink-soft)' }}>
                          → {formatDate(m.isoDate, timezone)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--ink-muted)' }}>→ date non déterminée</span>
                      )}
                      {m.sourcePage ? (
                        <span style={{ color: 'var(--ink-muted)' }}> (page {m.sourcePage})</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {!canOpenOriginal ? (
              <p className="disclaimer">
                L’original sera disponible une fois le traitement terminé.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

/** Documents received from the client, grouped by type, newest first. */
export function DocumentsPanel({
  caseId,
  documents,
  timezone,
}: {
  caseId: string;
  documents: CaseDocument[];
  timezone: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = documents.find((d) => d.id === openId) ?? null;

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: documents
      .filter((d) => d.category === category)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
  })).filter((g): g is { category: DocumentCategory; items: CaseDocument[] } => g.items.length > 0);

  return (
    <section className="panel" aria-label="Documents">
      <p className="section-label">
        Documents du client <span className="tabular">({documents.length})</span>
      </p>
      {groups.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>Aucun document reçu.</p>
      ) : (
        groups.map((g) => (
          <div key={g.category} style={{ marginTop: 20 }}>
            <h3 className="font-serif sub-title">
              {CATEGORY_LABEL[g.category]} <span className="tabular">({g.items.length})</span>
            </h3>
            <ul className="plain-list">
              {g.items.map((d) => (
                <li key={d.id}>
                  <button type="button" className="doc-row" onClick={() => setOpenId(d.id)}>
                    <span className="doc-row__name">{d.name}</span>
                    <span className="doc-row__meta">
                      {formatBytes(d.byteSize)} · {formatDateTime(d.receivedAt, timezone)}
                    </span>
                    <span className={statusClass(d.status)}>{DOCUMENT_STATUS_LABEL[d.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {open ? (
        <DocumentModal
          caseId={caseId}
          document={open}
          timezone={timezone}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </section>
  );
}
