/**
 * Urgency tag — triple encoding: colour + shape + text.
 * Use it wherever an urgency level appears next to a case.
 */

import { Glyph } from './Glyph';
import { URGENCY } from '@/lib/legal';
import type { Urgency } from '@/types/lexora';

interface Props {
  urgency: Urgency;
  size?: 'inline' | 'medium' | 'ward';
  showLabel?: boolean;
}

export function UrgencyTag({ urgency, size = 'inline', showLabel = true }: Props) {
  const u = URGENCY[urgency];
  return (
    <span
      className="inline-flex items-center gap-2 align-middle"
      aria-label={`Urgence : ${u.label}`}
    >
      <Glyph shape={u.glyph} size={size} color={u.colorVar} pulseClass={u.pulseClass} />
      {showLabel ? (
        <span
          className="uppercase text-[13px] font-semibold tracking-[0.18em]"
          style={{ color: u.colorVar }}
        >
          {u.label}
        </span>
      ) : null}
    </span>
  );
}
