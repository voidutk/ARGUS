/**
 * The complaint narrative with its extracted identifiers highlighted in place
 * (docs/PROJECT.md §E.4).
 *
 * This is the component that makes the extraction VISIBLE. A list of entities
 * beside the text asks the reader to take it on trust; marking them where they
 * appear shows the machine reading the same sentence a human is, and it is what
 * makes §T scene 2 land.
 *
 * Matching is done on the raw text rather than on stored offsets, because the
 * API does not return offsets — `context_snippet` is populated for live
 * extractions and null for seeded rows, so it cannot be relied on. Finding the
 * value in the text is also more robust: it survives a narrative being edited
 * after extraction, where a stored offset would silently point at the wrong
 * characters.
 */

import { useMemo } from 'react';
import { ENTITY_TYPES } from '@/utils/format';
import { cn } from '@/lib/utils';

/** Regex-escape a literal so a value containing `.` or `+` matches itself. */
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every place an entity appears, as `{ start, end, entity }`.
 *
 * Each entity is tried by its literal `value` first and its `normalized_value`
 * second — a phone stored as `9334825546` may be written `+91 9334825546` in
 * the prose, and a UPI id is often shouted in capitals. Matching is
 * case-insensitive for that reason.
 *
 * Overlaps are resolved by taking the LONGEST match at any position. Without
 * that, a bank account `32118638954` and a phone that shares its leading digits
 * would fight, and the shorter one would win by appearing first in the list.
 */
function findSpans(narrative, entities) {
  if (!narrative || !entities?.length) return [];

  const candidates = [];
  for (const entity of entities) {
    const needles = [entity.value, entity.normalized_value].filter(
      (v, i, arr) => v && arr.indexOf(v) === i
    );

    for (const needle of needles) {
      // Short values would match inside unrelated words; only search for
      // something long enough to be an identifier.
      if (String(needle).length < 4) continue;

      const re = new RegExp(escape(needle), 'gi');
      let match;
      while ((match = re.exec(narrative)) !== null) {
        candidates.push({ start: match.index, end: match.index + match[0].length, entity });
        if (re.lastIndex === match.index) re.lastIndex++; // guard against zero-width
      }
      // One spelling is enough; a second pass would double-mark the same text.
      if (candidates.some((c) => c.entity === entity)) break;
    }
  }

  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  const spans = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // overlaps something already claimed
    spans.push(c);
    cursor = c.end;
  }
  return spans;
}

/**
 * Colour by ROLE, not by entity type.
 *
 * A narrative names the victim's own phone alongside the suspect's, and
 * colouring both the same would imply the system cannot tell them apart — which
 * is precisely the distinction the correlation engine depends on. Ten type
 * colours would also turn a paragraph into confetti; two roles keep it
 * readable.
 */
const ROLE_STYLE = {
  VICTIM: { colour: '#8b9bb4', label: 'victim identifier' },
  SUSPECT: { colour: '#5b93ff', label: 'suspect identifier' },
  INTERMEDIARY: { colour: '#f5a623', label: 'intermediary' },
};

function Mark({ entity, children, onSelect, active }) {
  const style = ROLE_STYLE[entity.role] ?? ROLE_STYLE.SUSPECT;
  const typeLabel = ENTITY_TYPES[entity.entity_type]?.label ?? entity.entity_type;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(entity)}
      title={`${typeLabel} · ${style.label} · ${Math.round((entity.confidence ?? 1) * 100)}% confidence${
        entity.method ? ` · ${entity.method}` : ''
      }`}
      className={cn(
        'mn cursor-pointer rounded-[2px] px-[3px] py-[1px] transition-colors',
        active && 'ring-1'
      )}
      style={{
        color: style.colour,
        background: `color-mix(in oklab, ${style.colour} ${active ? 22 : 13}%, transparent)`,
        boxShadow: `inset 0 -1px 0 0 color-mix(in oklab, ${style.colour} 45%, transparent)`,
        // eslint-disable-next-line no-undefined
        '--tw-ring-color': active ? style.colour : undefined,
      }}
    >
      {children}
    </button>
  );
}

export default function NarrativeHighlight({ narrative, entities, onSelect, selectedId, className }) {
  const spans = useMemo(() => findSpans(narrative, entities), [narrative, entities]);

  const parts = useMemo(() => {
    if (!narrative) return [];
    if (!spans.length) return [{ text: narrative }];

    const out = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) out.push({ text: narrative.slice(cursor, span.start) });
      out.push({ text: narrative.slice(span.start, span.end), entity: span.entity });
      cursor = span.end;
    }
    if (cursor < narrative.length) out.push({ text: narrative.slice(cursor) });
    return out;
  }, [narrative, spans]);

  return (
    <div className={cn('text-[13px] leading-[1.75] text-dim', className)}>
      {parts.map((part, i) =>
        part.entity ? (
          <Mark
            key={i}
            entity={part.entity}
            onSelect={onSelect}
            active={selectedId === part.entity.id}
          >
            {part.text}
          </Mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </div>
  );
}

/** Exported for the legend, so the colours are declared in exactly one place. */
export { ROLE_STYLE, findSpans };
