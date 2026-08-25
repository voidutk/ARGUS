/**
 * Complaint Intelligence (docs/PROJECT.md §E.4).
 *
 * The page that turns one filing into a lead. Its whole argument is the
 * relationship between three panels:
 *
 *   the narrative      with its identifiers marked where they appear
 *   the entities       what was pulled out, with confidence and method
 *   linked complaints  every OTHER filing sharing an identifier
 *
 * The third is the payoff and it is why this page exists. An investigator
 * reading this complaint alone sees one victim and one loss; the linked panel
 * says the same account took money from thirteen other people across four
 * states. That is not a detail view, it is the product.
 *
 * The NCRB baseline in the sidebar is deliberate too: one real, citable number
 * (PLAN-V2 §2) beside our synthetic corpus, badged as official, so the page
 * never leaves a reader unsure which is which.
 */

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Link2 } from 'lucide-react';

import { complaints as complaintsApi, reference as referenceApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import NarrativeHighlight, { ROLE_STYLE, findSpans } from '@/components/complaint/NarrativeHighlight';
import { Chip, Dot, Empty, Failed, Loading, Meter, Panel, Provenance, Severity } from '@/components/ui/Bits';
import {
  clusterColour, dateOnly, elide, entityLabel, inr, num, provenanceOf, scamLabel, stamp,
} from '@/utils/format';
import { cn } from '@/lib/utils';

function Field({ label, children, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="lbl">{label}</span>
      <span className={cn('truncate text-[12.5px] text-txt', mono && 'mn')}>{children ?? '—'}</span>
    </div>
  );
}

/**
 * The NCRB baseline — Layer 1, and the only genuinely official data on screen.
 *
 * Fetched per district and allowed to fail quietly: reference data is context,
 * not the record, and a missing baseline must not put an error card on a page
 * that is otherwise complete.
 */
function NcrbBaseline({ state, district }) {
  const { data, error, loading } = useApi(
    () => referenceApi.district(state, district),
    [state, district],
    { enabled: Boolean(state && district) }
  );

  if (!state || !district) return null;
  if (loading) return <Loading label="NCRB" className="py-4" />;
  // No published figure for this district is a fact, not a failure.
  if (error || !data?.latest) return null;

  const cheating = data.latest.CHEATING;
  const share = data.share_of_state?.CHEATING;

  return (
    <Panel
      title="NCRB baseline"
      subtitle={String(data.latest_year)}
      right={<Provenance of={provenanceOf(data)} />}
    >
      <div className="flex flex-col gap-2">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            {/*
              NCRB's own spelling, not ours. It carries administrative suffixes
              our complaints do not ("Bengaluru City", "Pune Commr."), and
              showing the resolved name is what stops a figure being attributed
              to a place it did not come from.
            */}
            <span className="text-[11px] text-dim">Cheating cases, {data.district}</span>
            <span className="mn text-[15px] font-semibold text-txt">{num(cheating)}</span>
          </div>
          {!data.exact_match && (
            <p className="mt-0.5 text-[10px] text-faint">
              matched from &ldquo;{data.requested_district}&rdquo; — NCRB records it as{' '}
              <span className="text-dim">{data.district}</span>
            </p>
          )}
          {share > 0 && (
            <>
              <Meter value={share * 100} colour="#10b981" className="mt-1.5" height={2} />
              <span className="mt-1 block text-[10px] text-faint">
                {(share * 100).toFixed(1)}% of {state}&apos;s {num(data.state_totals?.CHEATING)} recorded cases
              </span>
            </>
          )}
        </div>
        <p className="text-[10px] leading-relaxed text-faint">{data.source_note}</p>
      </div>
    </Panel>
  );
}

export default function ComplaintDetail() {
  const { id } = useParams();
  const { data, error, loading, refetch } = useApi(() => complaintsApi.detail(id), [id]);
  const [selectedEntityId, setSelectedEntityId] = useState(null);

  /**
   * Which entities actually appear in the prose.
   *
   * Only about half do, and that is correct rather than a matching failure:
   * the victim's own phone and email arrive from the intake FORM FIELDS, and
   * some suspect-side identifiers — an IP from a login alert, a device
   * fingerprint — are attached from records the victim never quoted.
   *
   * Without saying so, the panel is quietly confusing: an investigator clicks
   * an entity, nothing lights up in the narrative, and they are left unsure
   * whether the extraction missed it or it was never there. Marking the source
   * answers that, and is the more honest presentation anyway — "we know this
   * from a bank record" is a different claim from "the victim wrote this down".
   *
   * Computed ABOVE the loading guards: hooks must run in the same order on
   * every render, so it cannot sit after an early return.
   */
  const inNarrative = useMemo(
    () => new Set(
      findSpans(data?.complaint?.narrative, data?.entities).map((s) => s.entity.id)
    ),
    [data]
  );

  if (loading && !data) return <div className="p-4"><Loading label="Loading complaint" /></div>;
  if (error) return <div className="p-4"><Failed error={error} onRetry={refetch} /></div>;
  if (!data) return null;

  const { complaint, entities, linked, cluster } = data;
  const suspects = entities.filter((e) => e.role !== 'VICTIM');
  const victimSide = entities.filter((e) => e.role === 'VICTIM');

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* ---- header ---- */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            to="/complaints"
            className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[3px] border border-hair text-faint transition-colors hover:border-faint hover:text-txt"
          >
            <ArrowLeft className="size-3.5" strokeWidth={2} />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="mn text-[15px] font-semibold text-txt">{complaint.complaint_ref}</h1>
              <Chip>{scamLabel(complaint.status)}</Chip>
            </div>
            <p className="mt-0.5 text-[11.5px] text-faint">
              {scamLabel(complaint.scam_category)} · filed {stamp(complaint.filed_at)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-baseline gap-1.5">
          <span className="mn text-[22px] leading-none font-semibold text-txt">
            {inr(complaint.amount_inr, { compact: true })}
          </span>
          <span className="text-[10.5px] text-faint">reported loss</span>
        </div>
      </div>

      {/*
        The cluster banner. When a complaint belongs to a known organisation
        that is the single most important fact on the page, so it sits above
        everything else rather than in a sidebar.
      */}
      {cluster && (
        <Link
          to={`/network?focus=${encodeURIComponent(cluster.cluster_key)}`}
          className="group flex items-center gap-3 rounded-[3px] border px-3 py-2 transition-colors"
          style={{
            borderColor: `color-mix(in oklab, ${clusterColour(cluster.cluster_key)} 32%, transparent)`,
            background: `color-mix(in oklab, ${clusterColour(cluster.cluster_key)} 7%, transparent)`,
          }}
        >
          <Dot colour={clusterColour(cluster.cluster_key)} size={7} pulse />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-txt">
              Part of{' '}
              <span className="mn font-semibold" style={{ color: clusterColour(cluster.cluster_key) }}>
                {cluster.cluster_key}
              </span>{' '}
              — {cluster.label}
            </p>
            <p className="mt-0.5 text-[10.5px] text-faint">
              {num(cluster.complaint_count)} complaints · {num(cluster.states_touched)} states ·{' '}
              {inr(cluster.total_amount_inr, { compact: true })} exposed
              {cluster.mastermind_label && <> · coordinator {cluster.mastermind_label}</>}
            </p>
          </div>
          <Severity level={cluster.risk_level} />
          <ExternalLink className="size-3 text-faint transition-colors group-hover:text-txt" strokeWidth={1.75} />
        </Link>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_312px]">
        {/* ---- left column ---- */}
        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title="Narrative"
            subtitle="identifiers marked where they appear"
            right={
              <div className="flex items-center gap-2">
                {Object.entries(ROLE_STYLE).map(([role, s]) => (
                  <span key={role} className="flex items-center gap-1">
                    <span className="size-1.5 rounded-[1px]" style={{ background: s.colour }} />
                    <span className="text-[9.5px] text-faint capitalize">{role.toLowerCase()}</span>
                  </span>
                ))}
              </div>
            }
          >
            <NarrativeHighlight
              narrative={complaint.narrative}
              entities={entities}
              selectedId={selectedEntityId}
              onSelect={(e) => setSelectedEntityId((prev) => (prev === e.id ? null : e.id))}
            />
          </Panel>

          {/*
            Linked complaints — the payoff.

            Ranked by how many identifiers are shared, because that is the
            strength of the link. The shared values are named, not counted: an
            investigator needs to know it was the same mule ACCOUNT, not merely
            that "4 things matched".
          */}
          <Panel
            title="Linked complaints"
            subtitle={linked.length ? `${num(linked.length)} share an identifier` : undefined}
            flush
            right={<Link2 className="size-3 text-faint" strokeWidth={1.75} />}
          >
            {!linked.length ? (
              <Empty
                title="No linked complaints"
                hint="No other filing shares a suspect-side identifier with this one — yet."
              />
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {linked.map((l) => (
                  <Link
                    key={l.complaint_id}
                    to={`/complaints/${l.complaint_id}`}
                    className="row-hover flex items-center gap-3 border-b border-hair px-3 py-2 last:border-b-0"
                  >
                    <span className="mn w-6 shrink-0 text-center text-[13px] font-semibold text-bluehi">
                      {l.shared_count}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="mn text-[11.5px] text-txt">{l.complaint_ref}</span>
                        <span className="text-[10.5px] text-faint">
                          {scamLabel(l.scam_category)} · {l.state ?? '—'}
                        </span>
                      </div>
                      <p className="truncate text-[10.5px] text-faint">
                        via {l.shared_values?.slice(0, 3).join(', ')}
                        {l.shared_values?.length > 3 && ` +${l.shared_values.length - 3}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="mn text-[11.5px] text-txt">{inr(l.amount_inr, { compact: true })}</span>
                      <span className="text-[10px] text-faint">{dateOnly(l.filed_at)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ---- right column ---- */}
        <div className="flex flex-col gap-3">
          <Panel title="Victim">
            <div className="flex flex-col gap-2.5">
              <Field label="Name">{complaint.victim_name}</Field>
              <Field label="Phone" mono>{complaint.victim_phone}</Field>
              <Field label="Email" mono>{complaint.victim_email}</Field>
              <Field label="Location">
                {[complaint.district, complaint.state].filter(Boolean).join(', ') || '—'}
              </Field>
            </div>
          </Panel>

          <Panel
            title="Extracted entities"
            subtitle={`${num(inNarrative.size)} of ${num(entities.length)} quoted in the narrative`}
            flush
          >
            {!entities.length ? (
              <Empty title="Nothing extracted" hint="No identifiers were found in this narrative." />
            ) : (
              <div className="max-h-[380px] overflow-y-auto">
                {[...suspects, ...victimSide].map((e) => {
                  const style = ROLE_STYLE[e.role] ?? ROLE_STYLE.SUSPECT;
                  const active = selectedEntityId === e.id;
                  return (
                    <button
                      key={`${e.id}-${e.role}`}
                      type="button"
                      onClick={() => setSelectedEntityId((prev) => (prev === e.id ? null : e.id))}
                      title={inNarrative.has(e.id) ? 'Highlight in the narrative' : 'Not quoted in the narrative'}
                      className={cn(
                        'row-hover flex w-full items-center gap-2.5 border-b border-hair px-3 py-2 text-left last:border-b-0',
                        active && 'bg-raise',
                        !inNarrative.has(e.id) && 'opacity-65'
                      )}
                    >
                      <span className="mt-px size-1.5 shrink-0 rounded-[1px]" style={{ background: style.colour }} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="mn truncate text-[11.5px] text-txt">
                          {e.label || elide(e.value, 16, 8)}
                        </span>
                        <span className="text-[10px] text-faint">
                          {entityLabel(e.entity_type)}
                          {e.method && <> · {e.method}</>}
                          {e.confidence != null && <> · {Math.round(e.confidence * 100)}%</>}
                          {!inNarrative.has(e.id) && (
                            <span className="text-faint/70">
                              {' · '}
                              {e.role === 'VICTIM' ? 'from intake form' : 'from records'}
                            </span>
                          )}
                        </span>
                      </div>
                      {e.is_flagged && <Dot colour="#ff4757" size={5} />}
                      {e.cluster_key && (
                        <span className="mn shrink-0 text-[9.5px]" style={{ color: clusterColour(e.cluster_key) }}>
                          {e.cluster_key}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <NcrbBaseline state={complaint.state} district={complaint.district} />

          <Panel title="Money trail">
            <Link
              to={`/money?complaint=${complaint.id}`}
              className="flex items-center justify-between gap-2 text-[12px] text-bluehi transition-colors hover:text-txt"
            >
              Trace where the money went
              <ExternalLink className="size-3" strokeWidth={1.75} />
            </Link>
          </Panel>
        </div>
      </div>
    </div>
  );
}
