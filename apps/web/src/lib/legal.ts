/**
 * Presentation constants for urgency, documents and alert delivery.
 * Urgency is always shown with colour + shape + text (never colour alone).
 */

import type {
  AnalysisStatus,
  DocumentCategory,
  DocumentStatus,
  EscalationStatus,
  Urgency,
} from '@/types/lexora';

export type GlyphShape = 'circle-filled' | 'diamond' | 'triangle' | 'circle-hollow';

export interface UrgencyDescriptor {
  urgency: Urgency;
  label: string;
  rank: number;
  glyph: GlyphShape;
  pulseClass: '' | 'pulse-high' | 'pulse-med';
  colorVar: string;
  colorPaleVar: string;
}

export const URGENCY: Record<Urgency, UrgencyDescriptor> = {
  CRITICAL: {
    urgency: 'CRITICAL',
    label: 'Critique',
    rank: 3,
    glyph: 'triangle',
    pulseClass: 'pulse-high',
    colorVar: 'var(--critical)',
    colorPaleVar: 'var(--critical-pale)',
  },
  HIGH: {
    urgency: 'HIGH',
    label: 'Élevée',
    rank: 2,
    glyph: 'diamond',
    pulseClass: 'pulse-med',
    colorVar: 'var(--warning)',
    colorPaleVar: 'var(--warning-pale)',
  },
  MEDIUM: {
    urgency: 'MEDIUM',
    label: 'Moyenne',
    rank: 1,
    glyph: 'circle-hollow',
    pulseClass: '',
    colorVar: 'var(--info)',
    colorPaleVar: 'var(--info-pale)',
  },
  LOW: {
    urgency: 'LOW',
    label: 'Faible',
    rank: 0,
    glyph: 'circle-filled',
    pulseClass: '',
    colorVar: 'var(--stable)',
    colorPaleVar: 'var(--stable-pale)',
  },
};

export const isUrgent = (u: Urgency): boolean => u === 'HIGH' || u === 'CRITICAL';

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  ok: 'Analyse automatique',
  fallback: 'Analyse automatique indisponible — dossier à examiner manuellement',
};

export const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  decision: 'Décisions et convocations',
  proces_verbal: 'Procès-verbaux',
  identite: 'Pièces d’identité',
  preuve: 'Preuves (photos, captures)',
  correspondance: 'Correspondances',
  autre: 'Autres documents',
};

/** Display order of the document groups. */
export const CATEGORY_ORDER: readonly DocumentCategory[] = [
  'decision',
  'proces_verbal',
  'preuve',
  'correspondance',
  'identite',
  'autre',
];

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  pending: 'En attente',
  stored: 'Reçu',
  extracting: 'Lecture en cours',
  ready: 'Lu',
  rejected: 'Refusé',
  failed: 'Lecture impossible',
};

export interface EscalationDescriptor {
  label: string;
  /** Needs the lawyer's attention: the alert may not have reached them. */
  attention: boolean;
}

export const ESCALATION: Record<EscalationStatus, EscalationDescriptor> = {
  pending: { label: 'Alerte en attente d’envoi', attention: false },
  sending: { label: 'Alerte en cours d’envoi', attention: false },
  accepted: { label: 'Alerte acceptée par WhatsApp (non confirmée reçue)', attention: false },
  delivered: { label: 'Alerte WhatsApp distribuée', attention: false },
  failed: { label: 'Échec de l’envoi de l’alerte', attention: true },
  delivery_unknown: { label: 'Envoi de l’alerte incertain — à vérifier', attention: true },
  blocked_no_lawyer: { label: 'Aucun avocat assigné — alerte bloquée', attention: true },
  blocked_template_required: {
    label: 'Alerte bloquée — fenêtre WhatsApp fermée',
    attention: true,
  },
  simulated: { label: 'Alerte simulée (démo, rien n’a été envoyé)', attention: false },
};

/* ── Formatting ───────────────────────────────────────────────────── */

export function formatDateTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < MINUTE) return 'à l’instant';
  if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `il y a ${Math.floor(diff / HOUR)} h`;
  return `il y a ${Math.floor(diff / DAY)} j`;
}

/** Countdown to a deadline, e.g. "dans 14 h" / "dépassée de 2 j". */
export function formatCountdown(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const text =
    abs < HOUR
      ? `${Math.max(1, Math.round(abs / MINUTE))} min`
      : abs < DAY
        ? `${Math.round(abs / HOUR)} h`
        : `${Math.round(abs / DAY)} j`;
  return diff >= 0 ? `dans ${text}` : `dépassée de ${text}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
