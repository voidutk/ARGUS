/**
 * The shared primitives — docs/PROJECT.md §K names these explicitly:
 * Panel · Stat · Dot · Severity · Empty · Spinner.
 *
 * They sit alongside shadcn rather than replacing it. shadcn supplies the
 * pieces with real interaction complexity (Dialog, Select, Tooltip — focus
 * traps and ARIA that are genuinely hard to get right); these supply the
 * information-display vocabulary this product repeats on every page, which no
 * component library ships because it is specific to an intelligence tool.
 *
 * The visual restraint here is deliberate and is the whole difference between
 * this and a generic dashboard: hairline borders instead of shadows, 3px radii,
 * tabular numerals on every figure, and colour used only where it carries
 * meaning.
 */

import { cn } from '@/lib/utils';
import { SEVERITY, severityColour } from '@/utils/format';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * The standard surface. A title row with an uppercase label, an optional right
 * slot for controls, and a flush body.
 *
 * `flush` exists for panels whose content is a table or a canvas — content that
 * should meet the panel border with no gutter, because padding around a data
 * grid wastes the density this layout is built for.
 */
export function Panel({ title, subtitle, right, children, className, bodyClassName, flush = false }) {
  return (
    <section className={cn('glass flex min-h-0 flex-col', className)}>
      {(title || right) && (
        <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-hair px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            {title && <h2 className="lbl truncate">{title}</h2>}
            {subtitle && <span className="truncate text-[11px] text-faint">{subtitle}</span>}
          </div>
          {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', flush ? '' : 'p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

/**
 * One headline figure.
 *
 * The value is monospace and tabular so a row of Stats aligns on the decimal
 * rather than drifting with digit widths — the row reads as an instrument
 * cluster instead of as four unrelated cards.
 */
export function Stat({ label, value, unit, hint, tone = 'default', className }) {
  const tones = {
    default: 'text-txt',
    critical: 'text-danger',
    high: 'text-amber',
    good: 'text-emerald',
    muted: 'text-dim',
  };
  return (
    <div className={cn('flex flex-col justify-between gap-2', className)}>
      <span className="lbl">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('mn text-2xl leading-none font-semibold tracking-tight', tones[tone])}>
          {value}
        </span>
        {unit && <span className="mn text-xs text-faint">{unit}</span>}
      </div>
      {hint && <span className="truncate text-[11px] text-faint">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dot
// ---------------------------------------------------------------------------

/** A status dot. `pulse` marks a live signal and is used sparingly. */
export function Dot({ colour = '#8b9bb4', pulse = false, size = 6, className, title }) {
  return (
    <span
      title={title}
      className={cn('inline-block shrink-0 rounded-full', pulse && 'pulse', className)}
      style={{ width: size, height: size, background: colour }}
    />
  );
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * A severity badge.
 *
 * Deliberately a tinted dot plus a word rather than a solid filled block: a
 * feed of twenty alerts rendered as twenty saturated red rectangles is
 * unreadable, and the eye stops distinguishing critical from high — which is
 * the only thing the badge exists to do.
 */
export function Severity({ level, className, showLabel = true }) {
  const key = String(level ?? 'LOW').toUpperCase();
  const meta = SEVERITY[key] ?? SEVERITY.LOW;
  const colour = severityColour(key);
  return (
    <span
      className={cn(
        'inline-flex h-[19px] shrink-0 items-center gap-1.5 rounded-[2px] border px-1.5 text-[10px] font-semibold tracking-wide uppercase',
        className
      )}
      style={{
        color: colour,
        borderColor: `color-mix(in oklab, ${colour} 32%, transparent)`,
        background: `color-mix(in oklab, ${colour} 11%, transparent)`,
      }}
    >
      <Dot colour={colour} size={5} />
      {showLabel && meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

/** A small bordered pill. `tone` tints it when the value carries meaning. */
export function Chip({ children, colour, className, onClick, active = false, title }) {
  const interactive = typeof onClick === 'function';
  return (
    <button
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      title={title}
      disabled={!interactive}
      className={cn(
        'chip',
        interactive && 'cursor-pointer transition-colors hover:border-faint hover:text-txt',
        !interactive && 'cursor-default',
        active && 'border-blue text-txt',
        className
      )}
      style={
        colour
          ? {
              color: colour,
              borderColor: `color-mix(in oklab, ${colour} 34%, transparent)`,
              background: `color-mix(in oklab, ${colour} 10%, transparent)`,
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Provenance — docs/PLAN-V2-DATA-AND-INTEL.md §1
// ---------------------------------------------------------------------------

/**
 * The badge that says where a number came from.
 *
 * Takes the resolved descriptor from `provenanceOf(payload)` rather than a
 * hand-passed string, so a page physically cannot label synthetic data as
 * official — the label comes from the response, which is the plan's rule.
 * Renders nothing when the payload declares nothing, which is itself honest:
 * an unbadged number is one nobody claimed a source for.
 */
export function Provenance({ of, className }) {
  if (!of) return null;
  return (
    <span
      className={cn(
        'inline-flex h-[19px] items-center gap-1.5 rounded-[2px] border px-1.5 text-[10px] font-semibold tracking-wider uppercase',
        className
      )}
      style={{
        color: of.colour,
        borderColor: `color-mix(in oklab, ${of.colour} 30%, transparent)`,
        background: `color-mix(in oklab, ${of.colour} 10%, transparent)`,
      }}
      title={
        of.key === 'OFFICIAL'
          ? 'Official National Crime Records Bureau statistics'
          : of.key === 'SIMULATED'
            ? 'Illustrative — no live query was made'
            : 'Synthetic operational data generated for this platform'
      }
    >
      {of.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty / Spinner / Error
// ---------------------------------------------------------------------------

/**
 * The empty state.
 *
 * Says what would be here and why it is not. "No results" alone leaves a user
 * unsure whether they filtered too hard or the service is broken, and those
 * need different reactions.
 */
export function Empty({ title = 'Nothing to show', hint, icon: Icon, className, action }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {Icon && <Icon className="size-5 text-faint" strokeWidth={1.5} />}
      <p className="text-[13px] text-dim">{title}</p>
      {hint && <p className="max-w-[42ch] text-[11px] leading-relaxed text-faint">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ className, size = 14 }) {
  return (
    <svg
      className={cn('animate-spin text-faint', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** The loading state for a panel body — centred, quiet, no layout shift. */
export function Loading({ label = 'Loading', className }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10', className)}>
      <Spinner />
      <span className="text-[12px] text-faint">{label}…</span>
    </div>
  );
}

/**
 * A failed panel.
 *
 * Shows the server's own sentence, and the request id when there is one — the
 * backend logs the full stack against that id, so quoting it turns "it broke"
 * into a one-command diagnosis.
 */
export function Failed({ error, onRetry, className }) {
  const message = error?.message ?? String(error ?? 'Request failed');
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <p className="text-[13px] text-danger">{message}</p>
      {error?.requestId && <p className="mn text-[10px] text-faint">request {error.requestId}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-[2px] border border-hair px-2 py-1 text-[11px] text-dim transition-colors hover:border-faint hover:text-txt"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

/**
 * A bare inline trend line.
 *
 * Hand-rolled rather than pulled from a charting library on purpose. A chart
 * library's default sparkline arrives with axes, a tooltip, a legend and a
 * margin — all of which fight a 20px-tall figure, and all of which have to be
 * configured off. Seventeen lines of SVG has no defaults to argue with, and
 * ships nothing to the bundle.
 */
export function Sparkline({ points = [], width = 96, height = 22, colour = '#5b93ff', className }) {
  const values = points.map(Number).filter(Number.isFinite);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');

  return (
    <svg width={width} height={height} className={cn('overflow-visible', className)} aria-hidden="true">
      <path d={d} fill="none" stroke={colour} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={width}
        cy={height - ((values[values.length - 1] - min) / span) * height}
        r="1.75"
        fill={colour}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

/** A 0–100 bar. Used for the threat index and cluster risk. */
export function Meter({ value = 0, colour = '#2e6ff2', className, height = 3 }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div
      className={cn('w-full overflow-hidden rounded-full bg-raise', className)}
      style={{ height }}
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: colour }} />
    </div>
  );
}
