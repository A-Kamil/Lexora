/**
 * Control point before any request leaves the firm (inherited from mcp_rogue): the client's name,
 * phone and e-mail are removed from queries sent to public legal APIs. Decided by code, not by a model.
 */
const PHONE = /\+?\d[\d .-]{7,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

export interface RedactionResult { text: string; redacted: boolean }

export function redactForExternal(text: string, clientIdentifiers: string[]): RedactionResult {
  let out = text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  for (const id of clientIdentifiers.flatMap((s) => s.split(/\s+/)).filter((w) => w.length > 2)) {
    out = out.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[client]');
  }
  return { text: out, redacted: out !== text };
}
