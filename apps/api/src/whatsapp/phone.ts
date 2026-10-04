/** Kapso/Meta give WhatsApp numbers as bare digits ("33612345678"); the case store keys people on E.164. */
export function toE164(waNumber: string): string {
  const digits = waNumber.replace(/\D/g, '');
  return `+${digits}`;
}

/** E.164 -> the bare-digit form the WhatsApp Cloud API expects in `to`. */
export function toWhatsApp(e164: string): string {
  return e164.replace(/\D/g, '');
}

/** +33600000002 -> +336*****002: logs never carry a full phone number. */
export function maskPhone(number: string): string {
  if (number.length <= 6) return '***';
  return number.slice(0, 4) + '*'.repeat(number.length - 7) + number.slice(-3);
}
