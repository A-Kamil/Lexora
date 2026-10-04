import twilio from 'twilio';
import { DEFAULT_MODELS, analyzeCase, extractDocument, gatherLegalContext, mistralClient, transcribeVoice } from '@lexora/ai';
import type { WorkerConfig } from './config.js';
import type { AiPort, LegalPort, MediaDownloader, Messenger } from './ports.js';

export function liveAi(config: WorkerConfig): AiPort {
  const client = mistralClient(config.mistral.apiKey);
  const models = {
    analysis: config.mistral.models.analysis ?? DEFAULT_MODELS.analysis,
    ocr: config.mistral.models.ocr ?? DEFAULT_MODELS.ocr,
    transcription: config.mistral.models.transcription ?? DEFAULT_MODELS.transcription,
  };
  return {
    analyze: (input) => analyzeCase(client, input, models.analysis),
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

const whatsapp = (n: string) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);

export function twilioMessenger(config: WorkerConfig): Messenger {
  const { accountSid, authToken, whatsappNumber } = config.twilio;
  if (!accountSid || !authToken || !whatsappNumber) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_NUMBER are required in live messaging mode');
  const client = twilio(accountSid, authToken);
  return {
    async send(to, body) {
      const m = await client.messages.create({ from: whatsapp(whatsappNumber), to: whatsapp(to), body });
      return { status: 'sent', providerMessageId: m.sid };
    },
  };
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Twilio media: HTTPS on api.twilio.com only, Basic auth, 10 MiB cap (checked on headers and while streaming). */
export function twilioDownloader(config: WorkerConfig, fetchImpl: typeof fetch = fetch): MediaDownloader {
  return {
    async download(url) {
      const { accountSid, authToken } = config.twilio;
      if (!accountSid || !authToken) throw new Error('Twilio credentials missing');
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com') throw new Error('media URL not allowed');
      const res = await fetchImpl(u, {
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
        redirect: 'follow', // Twilio redirects to its CDN; fetch drops the Authorization header cross-origin
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok || !res.body) throw new Error(`media download ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIA_BYTES) throw new Error('media too large');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > MAX_MEDIA_BYTES) throw new Error('media too large');
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') };
    },
  };
}
