/**
 * Fictional demo data. Every person, case, document and date below is
 * invented. Times are relative to "now" so the dashboard always looks current.
 */

import type {
  AnalysisRecord,
  CaseDetail,
  CaseDocument,
  CaseList,
  CaseMessage,
  CaseSummary,
} from '@/types/lexora';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

const TZ = 'Europe/Paris';
const LAWYER = 'Me John Smith';

function doc(
  partial: Pick<CaseDocument, 'id' | 'name' | 'category' | 'mimeType' | 'receivedAt'> &
    Partial<CaseDocument>,
): CaseDocument {
  return {
    byteSize: 240_000,
    status: 'ready',
    summary: null,
    extractedText: null,
    dateMentions: [],
    errorReason: null,
    ...partial,
  };
}

function analysis(
  id: string,
  createdAt: string,
  reviewedDocumentCount: number,
  result: AnalysisRecord['result'],
  status: AnalysisRecord['status'] = 'ok',
): AnalysisRecord {
  return { id, createdAt, status, result, reviewedDocumentCount };
}

function message(
  id: string,
  direction: CaseMessage['direction'],
  author: string,
  createdAt: string,
  text: string,
  documentIds: string[] = [],
): CaseMessage {
  return { id, direction, author, createdAt, text, documentIds };
}

/* ── Sarah Miller — urgent hearing ─────────────────────────────────── */

const sarahHearing = ahead(19 * HOUR);

const sarahAnalysis = analysis('an-sarah-2', ago(11 * MIN), 2, {
  issue:
    'La cliente est convoquée à une audience demain matin et indique ne pas avoir reçu le dossier de la procédure.',
  urgency: 'HIGH',
  urgencyReason:
    'Une audience est annoncée dans moins de 24 heures et la cliente n’a pas encore de ligne de défense arrêtée avec son avocat.',
  requiresLawyer: true,
  missingInformation: [
    'Confirmation écrite de l’heure et de la salle d’audience',
    'Existence d’un éventuel témoin à citer',
    'Copie intégrale du procès-verbal d’audition',
  ],
  requestedDocuments: [
    'Procès-verbal d’audition complet (pages 3 et 4 manquantes)',
    'Justificatif de domicile récent',
  ],
  recommendedActions: [
    'Appeler la cliente avant la fin de journée pour préparer l’audience',
    'Vérifier la date et l’heure de la convocation auprès de la juridiction',
    'Demander la communication du dossier si ce n’est pas déjà fait',
  ],
});

const sarahDocuments: CaseDocument[] = [
  doc({
    id: 'd-sarah-1',
    name: 'Convocation audience.pdf',
    category: 'decision',
    mimeType: 'application/pdf',
    byteSize: 318_000,
    receivedAt: ago(26 * MIN),
    summary:
      'Convocation à une audience pénale, mentionnant une date et une heure d’audience ainsi que le nom de la cliente.',
    extractedText:
      'CONVOCATION\n\nMadame Sarah MILLER est convoquée à l’audience du tribunal correctionnel, 1re chambre, le lendemain à 09 h 30.\n\nElle est invitée à se présenter munie d’une pièce d’identité.\n\n(Document fictif de démonstration.)',
    dateMentions: [{ text: 'le lendemain à 09 h 30', isoDate: sarahHearing, sourcePage: 1 }],
  }),
  doc({
    id: 'd-sarah-2',
    name: 'PV audition (extrait).pdf',
    category: 'proces_verbal',
    mimeType: 'application/pdf',
    byteSize: 204_000,
    receivedAt: ago(25 * MIN),
    summary:
      'Extrait d’un procès-verbal d’audition (pages 1 et 2 seulement). La suite du document est absente.',
    extractedText:
      'PROCÈS-VERBAL D’AUDITION — page 1/4\n\nL’intéressée déclare s’être trouvée sur place à l’heure indiquée…\n\n(Document fictif de démonstration. Pages 3 et 4 non transmises.)',
    dateMentions: [{ text: 'à l’heure indiquée', isoDate: null, sourcePage: 1 }],
  }),
  doc({
    id: 'd-sarah-3',
    name: 'Photo 1.jpg',
    category: 'preuve',
    mimeType: 'image/jpeg',
    byteSize: 1_420_000,
    receivedAt: ago(12 * MIN),
    status: 'extracting',
  }),
  doc({
    id: 'd-sarah-4',
    name: 'Carte d’identité.png',
    category: 'identite',
    mimeType: 'image/png',
    byteSize: 880_000,
    receivedAt: ago(3 * DAY),
    summary: 'Pièce d’identité du client (document déjà au dossier).',
  }),
];

const sarah: CaseDetail = {
  id: 'case-sarah-miller',
  title: 'Procédure pénale — audience correctionnelle',
  status: 'open',
  jurisdiction: 'FR',
  language: 'fr',
  timezone: TZ,
  clientName: 'Sarah Miller',
  lawyerName: LAWYER,
  analysis: sarahAnalysis,
  history: [
    analysis('an-sarah-1', ago(3 * DAY), 0, {
      issue: 'Première prise de contact : la cliente présente sa situation.',
      urgency: 'MEDIUM',
      urgencyReason: 'Aucune échéance proche n’était connue à ce stade.',
      requiresLawyer: false,
      missingInformation: ['Date de la prochaine audience'],
      requestedDocuments: ['Convocation'],
      recommendedActions: ['Demander la convocation à la cliente'],
    }),
  ],
  escalation: { status: 'delivered', updatedAt: ago(9 * MIN) },
  deadlines: [
    {
      id: 'dl-sarah-1',
      title: 'Audience correctionnelle (fictive)',
      dueAt: sarahHearing,
      verification: 'confirmed',
    },
    {
      id: 'dl-sarah-2',
      title: 'Date relevée dans la convocation',
      dueAt: sarahHearing,
      verification: 'unverified',
    },
  ],
  documents: sarahDocuments,
  messages: [
    message(
      'm-sarah-1',
      'inbound',
      'Sarah Miller',
      ago(3 * DAY),
      'Bonjour Maître, j’ai reçu un courrier du tribunal, je ne comprends pas ce que je dois faire.',
    ),
    message(
      'm-sarah-2',
      'outbound',
      'Lexora',
      ago(3 * DAY - 2 * MIN),
      'Bonjour Madame Miller, pouvez-vous m’envoyer une photo ou un scan de ce courrier ?',
    ),
    message(
      'm-sarah-3',
      'inbound',
      'Sarah Miller',
      ago(27 * MIN),
      'Bonjour, mon audience est demain matin et je n’ai pas encore préparé ma défense, je suis très inquiète.',
    ),
    message('m-sarah-4', 'inbound', 'Sarah Miller', ago(26 * MIN), 'Voici la convocation.', [
      'd-sarah-1',
    ]),
    message(
      'm-sarah-5',
      'inbound',
      'Sarah Miller',
      ago(25 * MIN),
      'Et un extrait du procès-verbal que j’ai reçu.',
      ['d-sarah-2'],
    ),
    message(
      'm-sarah-6',
      'inbound',
      'Sarah Miller',
      ago(12 * MIN),
      'J’ai aussi des photos de la scène.',
      ['d-sarah-3'],
    ),
  ],
};

/* ── Thomas Girard — critical ──────────────────────────────────────── */

const thomas: CaseDetail = {
  id: 'case-thomas-girard',
  title: 'Procédure pénale — comparution rapprochée',
  status: 'open',
  jurisdiction: 'FR',
  language: 'fr',
  timezone: TZ,
  clientName: 'Thomas Girard',
  lawyerName: LAWYER,
  analysis: analysis('an-thomas-1', ago(48 * MIN), 1, {
    issue:
      'Le client indique qu’une audience a été avancée à ce soir et qu’il n’a pas pu joindre son avocat.',
    urgency: 'CRITICAL',
    urgencyReason:
      'Un changement d’horaire d’audience dans les prochaines heures est évoqué ; la nouvelle date doit être vérifiée immédiatement.',
    requiresLawyer: true,
    missingInformation: ['Nouvelle heure d’audience confirmée par la juridiction'],
    requestedDocuments: ['Courrier ou SMS de modification de la juridiction'],
    recommendedActions: [
      'Contacter immédiatement le client',
      'Vérifier le nouvel horaire auprès du greffe',
    ],
  }),
  history: [],
  escalation: { status: 'blocked_template_required', updatedAt: ago(47 * MIN) },
  deadlines: [
    {
      id: 'dl-thomas-1',
      title: 'Audience avancée (à vérifier)',
      dueAt: ahead(5 * HOUR),
      verification: 'unverified',
    },
  ],
  documents: [
    doc({
      id: 'd-thomas-1',
      name: 'Capture SMS greffe.png',
      category: 'correspondance',
      mimeType: 'image/png',
      byteSize: 560_000,
      receivedAt: ago(50 * MIN),
      summary: 'Capture d’écran d’un SMS évoquant un changement d’horaire d’audience.',
      extractedText:
        'Greffe : votre audience est avancée à 18 h 00. Merci de confirmer.\n\n(Message fictif de démonstration.)',
      dateMentions: [{ text: 'avancée à 18 h 00', isoDate: ahead(5 * HOUR), sourcePage: null }],
    }),
  ],
  messages: [
    message(
      'm-thomas-1',
      'inbound',
      'Thomas Girard',
      ago(51 * MIN),
      'Mon audience a été avancée à ce soir, je n’arrive pas à joindre mon avocat !',
    ),
    message(
      'm-thomas-2',
      'inbound',
      'Thomas Girard',
      ago(50 * MIN),
      'Voilà le message que j’ai reçu.',
      ['d-thomas-1'],
    ),
  ],
};

/* ── Léa Fontaine — medium ─────────────────────────────────────────── */

const lea: CaseDetail = {
  id: 'case-lea-fontaine',
  title: 'Plainte — pièces à compléter',
  status: 'open',
  jurisdiction: 'FR',
  language: 'fr',
  timezone: TZ,
  clientName: 'Léa Fontaine',
  lawyerName: LAWYER,
  analysis: analysis('an-lea-1', ago(5 * HOUR), 1, {
    issue: 'La cliente a déposé plainte et souhaite savoir quelles pièces fournir.',
    urgency: 'MEDIUM',
    urgencyReason: 'Aucune échéance proche, mais des pièces sont nécessaires pour avancer.',
    requiresLawyer: true,
    missingInformation: ['Date exacte des faits', 'Coordonnées d’un éventuel témoin'],
    requestedDocuments: [
      'Récépissé de dépôt de plainte',
      'Relevé des échanges avec la partie adverse',
    ],
    recommendedActions: [
      'Planifier un échange cette semaine',
      'Lister les pièces à fournir à la cliente',
    ],
  }),
  history: [],
  escalation: { status: 'simulated', updatedAt: ago(5 * HOUR) },
  deadlines: [],
  documents: [
    doc({
      id: 'd-lea-1',
      name: 'Récépissé de plainte.pdf',
      category: 'decision',
      mimeType: 'application/pdf',
      receivedAt: ago(5 * HOUR + 4 * MIN),
      summary: 'Récépissé de dépôt de plainte (document fictif).',
    }),
    doc({
      id: 'd-lea-2',
      name: 'Échanges SMS.pdf',
      category: 'correspondance',
      mimeType: 'application/pdf',
      receivedAt: ago(5 * HOUR + 3 * MIN),
      status: 'failed',
      errorReason: 'Fichier protégé : le texte n’a pas pu être lu.',
    }),
  ],
  messages: [
    message(
      'm-lea-1',
      'inbound',
      'Léa Fontaine',
      ago(5 * HOUR + 6 * MIN),
      'Bonjour, j’ai déposé plainte hier. Quels documents dois-je vous envoyer ?',
    ),
    message('m-lea-2', 'inbound', 'Léa Fontaine', ago(5 * HOUR + 4 * MIN), 'Voici le récépissé.', [
      'd-lea-1',
    ]),
    message(
      'm-lea-3',
      'inbound',
      'Léa Fontaine',
      ago(5 * HOUR + 3 * MIN),
      'Et mes échanges avec la personne.',
      ['d-lea-2'],
    ),
  ],
};

/* ── Marc Dubois — low ─────────────────────────────────────────────── */

const marc: CaseDetail = {
  id: 'case-marc-dubois',
  title: 'Suivi de dossier — mise à jour',
  status: 'open',
  jurisdiction: 'FR',
  language: 'fr',
  timezone: TZ,
  clientName: 'Marc Dubois',
  lawyerName: LAWYER,
  analysis: analysis('an-marc-1', ago(2 * DAY), 0, {
    issue: 'Le client remercie et demande des nouvelles générales de son dossier.',
    urgency: 'LOW',
    urgencyReason: 'Simple demande d’information, sans échéance ni fait nouveau.',
    requiresLawyer: false,
    missingInformation: [],
    requestedDocuments: [],
    recommendedActions: ['Répondre lors du prochain point de suivi'],
  }),
  history: [],
  escalation: null,
  deadlines: [
    {
      id: 'dl-marc-1',
      title: 'Prochain point de suivi (fictif)',
      dueAt: ahead(9 * DAY),
      verification: 'confirmed',
    },
  ],
  documents: [],
  messages: [
    message(
      'm-marc-1',
      'inbound',
      'Marc Dubois',
      ago(2 * DAY),
      'Bonjour Maître, merci pour votre aide. Y a-t-il du nouveau sur mon dossier ?',
    ),
  ],
};

const ALL: CaseDetail[] = [sarah, thomas, lea, marc];

function nextDeadline(c: CaseDetail): CaseSummary['nextDeadline'] {
  const upcoming = c.deadlines
    .filter((d) => new Date(d.dueAt).getTime() > Date.now())
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  return upcoming ? { title: upcoming.title, dueAt: upcoming.dueAt } : null;
}

function summarize(c: CaseDetail): CaseSummary {
  const lastMessage = c.messages[c.messages.length - 1];
  return {
    id: c.id,
    title: c.title,
    clientName: c.clientName,
    status: c.status,
    urgency: c.analysis?.result.urgency ?? 'MEDIUM',
    analysisStatus: c.analysis?.status ?? 'fallback',
    issue: c.analysis?.result.issue ?? 'Analyse en attente.',
    lastActivityAt: lastMessage?.createdAt ?? new Date().toISOString(),
    documentCount: c.documents.length,
    escalationStatus: c.escalation?.status ?? null,
    nextDeadline: nextDeadline(c),
    timezone: c.timezone,
  };
}

export const demoCaseList = (): CaseList => ({
  lawyerName: LAWYER,
  cases: ALL.map(summarize),
});

export const demoCaseDetail = (caseId: string): CaseDetail | null =>
  ALL.find((c) => c.id === caseId) ?? null;
