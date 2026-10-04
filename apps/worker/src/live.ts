import {
  DEFAULT_MODELS,
  analyzeCase,
  converse,
  describeImage,
  embedTexts,
  extractDocument,
  gatherLegalContext,
  mistralClient,
  transcribeVoice,
} from '@lexora/ai';
import type { WorkerConfig } from './config.js';
import type { AiPort, LegalPort } from './ports.js';

export function liveAi(config: WorkerConfig): AiPort {
  const client = mistralClient(config.mistral.apiKey);
  const models = {
    analysis: config.mistral.models.analysis ?? DEFAULT_MODELS.analysis,
    ocr: config.mistral.models.ocr ?? DEFAULT_MODELS.ocr,
    transcription: config.mistral.models.transcription ?? DEFAULT_MODELS.transcription,
    vision: config.mistral.models.vision ?? DEFAULT_MODELS.vision,
  };
  return {
    analyze: (input) => analyzeCase(client, input, models.analysis),
    converse: async (input) => ({ text: await converse(client, input, models.analysis) }),
    transcribe: async (input) => ({
      text: (await transcribeVoice(client, input, models.transcription)).text,
    }),
    extract: async (input) => {
      if (!input.mimeType.startsWith('image/')) {
        const r = await extractDocument(client, input, models);
        return { text: r.text, documentType: r.metadata.documentType, summary: r.metadata.summary };
      }
      // Photo: OCR (exact text) and vision (what the picture shows) in parallel; either may fail alone.
      const [ocr, vision] = await Promise.allSettled([
        extractDocument(client, input, models),
        describeImage(client, input, models.vision),
      ]);
      if (ocr.status === 'rejected' && vision.status === 'rejected') throw ocr.reason;
      const r = ocr.status === 'fulfilled' ? ocr.value : null;
      const desc = vision.status === 'fulfilled' ? vision.value : null;
      const ocrText = r?.text.trim() ?? '';
      const mostlyPicture = ocrText.replace(/--- page \d+ ---/g, '').trim().length < 80;
      return {
        text: [ocrText, desc ? `DESCRIPTION DE LA PHOTO : ${desc}` : '']
          .filter(Boolean)
          .join('\n\n'),
        documentType: mostlyPicture ? 'photo' : (r?.metadata.documentType ?? 'photo'),
        summary: mostlyPicture
          ? (desc ?? r?.metadata.summary ?? '')
          : [r?.metadata.summary, desc ? `Photo : ${desc}` : ''].filter(Boolean).join(' — '),
      };
    },
    embed: (texts) => embedTexts(client, texts, DEFAULT_MODELS.embedding),
  };
}

export function liveLegal(config: WorkerConfig): LegalPort {
  return {
    gather: (question, opts) =>
      gatherLegalContext(question, {
        mode: config.legalContextMode,
        codes: ['procedure_penale', 'penal'],
        clientIdentifiers: opts.clientIdentifiers,
        ...(config.piste ? { piste: config.piste } : {}),
      }),
  };
}
