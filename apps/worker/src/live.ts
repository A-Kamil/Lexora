import { DEFAULT_MODELS, analyzeCase, converse, extractDocument, gatherLegalContext, mistralClient, transcribeVoice } from '@lexora/ai';
import type { WorkerConfig } from './config.js';
import type { AiPort, LegalPort } from './ports.js';

export function liveAi(config: WorkerConfig): AiPort {
  const client = mistralClient(config.mistral.apiKey);
  const models = {
    analysis: config.mistral.models.analysis ?? DEFAULT_MODELS.analysis,
    ocr: config.mistral.models.ocr ?? DEFAULT_MODELS.ocr,
    transcription: config.mistral.models.transcription ?? DEFAULT_MODELS.transcription,
  };
  return {
    analyze: (input) => analyzeCase(client, input, models.analysis),
    converse: async (input) => ({ text: await converse(client, input, models.analysis) }),
    transcribe: async (input) => ({ text: (await transcribeVoice(client, input, models.transcription)).text }),
    extract: async (input) => {
      const r = await extractDocument(client, input, models);
      return { text: r.text, documentType: r.metadata.documentType, summary: r.metadata.summary };
    },
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
