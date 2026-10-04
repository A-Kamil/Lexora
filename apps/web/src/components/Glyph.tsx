/**
 * Shape glyphs for dual-encoding urgency.
 * Always paired with text + color — never used alone.
 */

import type { CSSProperties } from 'react';
import type { GlyphShape } from '@/lib/legal';

type Size = 'inline' | 'medium' | 'ward';

const SIZES: Record<Size, { w: number; h: number; tri: { w: number; h: number } }> = {
  inline: { w: 13, h: 13, tri: { w: 9, h: 15 } },
  medium: { w: 19, h: 19, tri: { w: 14, h: 22 } },
  ward: { w: 30, h: 30, tri: { w: 22, h: 36 } },
};

export interface GlyphProps {
  shape: GlyphShape;
  size?: Size;
  color: string;
  pulseClass?: string;
  'aria-label'?: string;
}

export function Glyph({
  shape,
  size = 'medium',
  color,
  pulseClass = '',
  'aria-label': ariaLabel,
}: GlyphProps) {
  const dims = SIZES[size];
  const commonProps = {
    role: 'img' as const,
    'aria-label': ariaLabel,
    className: pulseClass,
  };

  if (shape === 'triangle') {
    const style: CSSProperties = {
      width: 0,
      height: 0,
      borderLeft: `${dims.tri.w / 2}px solid transparent`,
      borderRight: `${dims.tri.w / 2}px solid transparent`,
      borderBottom: `${dims.tri.h}px solid ${color}`,
      display: 'inline-block',
      verticalAlign: 'middle',
    };
    return <span style={style} {...commonProps} />;
  }

  if (shape === 'diamond') {
    const style: CSSProperties = {
      width: dims.w,
      height: dims.w,
      background: color,
      transform: 'rotate(45deg)',
      display: 'inline-block',
      verticalAlign: 'middle',
    };
    return <span style={style} {...commonProps} />;
  }

  if (shape === 'circle-filled') {
    const style: CSSProperties = {
      width: dims.w,
      height: dims.w,
      background: color,
      borderRadius: '50%',
      display: 'inline-block',
      verticalAlign: 'middle',
    };
    return <span style={style} {...commonProps} />;
  }

  /* circle-hollow */
  const style: CSSProperties = {
    width: dims.w,
    height: dims.w,
    border: `2px solid ${color}`,
    background: 'transparent',
    borderRadius: '50%',
    display: 'inline-block',
    boxSizing: 'border-box',
    verticalAlign: 'middle',
  };
  return <span style={style} {...commonProps} />;
}
