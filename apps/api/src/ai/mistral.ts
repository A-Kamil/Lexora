const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

const SYSTEM_PROMPT = `You are Lexora, a legal intake assistant for a law firm.
Reply in the user's language, keep answers short, and ask at most one question at a time.
Help collect facts and documents, but do not give legal advice or promise an outcome.
If the situation may be urgent, tell the user that a lawyer should review it promptly.`;

type MistralResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export function createMistralReply(
  config: { apiKey: string; model: string },
  fetchImpl: typeof fetch = fetch,
) {
  return async (message: string): Promise<string> => {
    const response = await fetchImpl(MISTRAL_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Mistral request failed (${response.status})`);
    }

    const payload = (await response.json()) as MistralResponse;
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Mistral returned an empty response');
    return content;
  };
}
