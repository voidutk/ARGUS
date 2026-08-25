/**
 * Investigation Timeline (docs/PROJECT.md §E.8) — Scene 8.
 *
 * Reads directly off `audit_logs`, which migration 001 declares APPEND-ONLY.
 * That is the whole claim of this page: it is not a feed assembled for display,
 * it is the record itself. An action that is not here did not happen as far as
 * the chain of custody is concerned.
 *
 * Rendered as a single continuous rail rather than as cards. A timeline is a
 * sequence, and a sequence broken into boxes stops reading as one — the spine
 * running down the left is what makes "then this, then this" legible at a
 * glance.
 */

import { useMemo, useState } from 'react';
import {
  Boxes, FileText, History, LogIn, Search, Shield, ShieldAlert, ShieldCheck, Upload, UserCog,
} from 'lucide-react';

import { timeline as timelineApi } from '@/api';
import { useApi, usePoll } from '@/hooks/useApi';
import { Empty, Failed, Loading, Panel } from '@/components/ui/Bits';
import { ago, num, stamp } from '@/utils/format';
import { cn } from '@/lib/utils';

/**
 * How each action reads.
 *
 * Evidence actions are given their own colours because they are the ones with
 * legal weight — an upload, a verification and a FAILED verification are not
 * the same kind of event as a login, and a timeline that renders them
 * identically buries the one entry a court would care about.
 */
const ACTION = {
  LOGIN: { icon: LogIn, colour: '#556074', label: 'Signed in' },
  LOGIN_FAILED: { icon: ShieldAlert, colour: '#f5a623', label: 'Failed sign-in' },
  COMPLAINT_RECEIVED: { icon: FileText, colour: '#5b93ff', label: 'Complaint filed' },
  COMPLAINT_STATUS_CHANGED: { icon: FileText, colour: '#8b9bb4', label: 'Status changed' },
  COMPLAINT_LINKED: { icon: Boxes, colour: '#a855f7', label: 'Linked to cluster' },
  ENTITIES_EXTRACTED: { icon: Search, colour: '#5b93ff', label: 'Entities extracted' },
  GRAPH_INGESTED: { icon: Boxes, colour: '#5b93ff', label: 'Merged into graph' },
  GRAPH_REBUILD: { icon: Boxes, colour: '#8b9bb4', label: 'Graph rebuilt' },
  CLUSTER_COMPUTED: { icon: Boxes, colour: '#a855f7', label: 'Clusters recomputed' },
  MASTERMIND_RANKED: { icon: UserCog, colour: '#a855f7', label: 'Coordinator ranked' },
  EVIDENCE_UPLOADED: { icon: Upload, colour: '#10b981', label: 'Evidence uploaded' },
  EVIDENCE_ANCHORED: { icon: Shield, colour: '#10b981', label: 'Anchored on-chain' },
  EVIDENCE_VERIFIED: { icon: ShieldCheck, colour: '#10b981', label: 'Integrity confirmed' },
  EVIDENCE_VERIFY_FAILED: { icon: ShieldAlert, colour: '#ff4757', label: 'INTEGRITY FAILED' },
  EVIDENCE_DOWNLOADED: { icon: FileText, colour: '#8b9bb4', label: 'Evidence downloaded' },
  EVIDENCE_REANCHORED: { icon: Shield, colour: '#5b93ff', label: 'Re-anchored' },
  ALERTS_REGENERATED: { icon: History, colour: '#8b9bb4', label: 'Rules re-run' },
  OSINT_QUERIED: { icon: Search, colour: '#8b9bb4', label: 'OSINT queried' },
  INVESTIGATION_OPENED: { icon: FileText, colour: '#5b93ff', label: 'Case opened' },
  INVESTIGATOR_ASSIGNED: { icon: UserCog, colour: '#5b93ff', label: 'Investigator assigned' },
};

const describe = (action) =>
  ACTION[action] ?? {
    icon: History,
    colour: '#556074',
    label: action.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
  };

/** Metadata rendered as chips — a JSON blob in a timeline is not a record. */
function Meta({ metadata }) {
  const pairs = useMemo(() => {
    if (!metadata || typeof metadata !== 'object') return [];
    return Object.entries(metadata)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, 5);
  }, [metadata]);

  if (!pairs.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {pairs.map(([k, v]) => (
        <span key={k} className="mn rounded-[2px] border border-hair bg-raise/50 px-1.5 py-[1px] text-[9.5px] text-faint">
          {k.replace(/_/g, ' ')} <span className="text-dim">{String(v).slice(0, 30)}</span>
        </span>
      ))}
    </div>
  );
}

const PAGE = 80;

export default function Timeline() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(0);

  const { data, error, loading, refetch } = useApi(
    () => timelineApi.list({ limit: PAGE, offset: page * PAGE, action: action || undefined }),
    [page, action]
  );
  usePoll(refetch, 20_000);

  // Built from what is actually present, so the filter can never offer an
  // action that would return nothing.
  const actionsPresent = useMemo(
    () => [...new Set((data?.events ?? []).map((e) => e.action))].sort(),
    [data]
  );

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Panel
        title="Investigation timeline"
        subtitle={data ? `${num(data.total)} recorded events` : undefined}
        flush
        className="min-h-0 flex-1"
        right={
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-faint">append-only record</span>
            <select
              value={action}
              onChange={(e) => { setAction(e.target.value); setPage(0); }}
              className={cn(
                'h-[26px] rounded-[3px] border border-hair bg-panel px-1.5 text-[11.5px] outline-none focus:border-blue',
                action ? 'text-txt' : 'text-faint'
              )}
            >
              <option value="">All actions</option>
              {actionsPresent.map((a) => (
                <option key={a} value={a}>{describe(a).label}</option>
              ))}
            </select>
          </div>
        }
      >
        <div className="h-full overflow-y-auto">
          {loading && !data ? (
            <Loading label="Loading the record" />
          ) : error ? (
            <Failed error={error} onRetry={refetch} />
          ) : !data?.events?.length ? (
            <Empty icon={History} title="No events recorded" />
          ) : (
            <div className="relative px-3 py-2">
              {/* The spine. Everything hangs off this one line, which is what
                  makes the sequence read as a sequence. */}
              <div className="absolute top-0 bottom-0 left-[26px] w-px bg-hair" />

              {data.events.map((e) => {
                const meta = describe(e.action);
                const Icon = meta.icon;
                const critical = e.action === 'EVIDENCE_VERIFY_FAILED';
                return (
                  <div key={e.id} className="relative flex gap-3 py-2">
                    <span
                      className="relative z-10 mt-px flex size-[17px] shrink-0 items-center justify-center rounded-full border"
                      style={{
                        borderColor: `color-mix(in oklab, ${meta.colour} 45%, transparent)`,
                        background: `color-mix(in oklab, ${meta.colour} 14%, #0c111c)`,
                      }}
                    >
                      <Icon className="size-[9px]" strokeWidth={2.25} style={{ color: meta.colour }} />
                    </span>

                    <div className={cn('min-w-0 flex-1', critical && 'rounded-[3px] border border-danger/30 bg-danger/[0.06] px-2 py-1.5')}>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span
                          className={cn('text-[12.5px]', critical ? 'font-semibold text-danger' : 'text-txt')}
                          style={!critical ? { color: meta.colour === '#556074' ? undefined : meta.colour } : undefined}
                        >
                          {meta.label}
                        </span>
                        {e.actor_name && (
                          <span className="text-[11px] text-dim">
                            {e.actor_name}
                            {e.actor_role && <span className="text-faint"> · {e.actor_role.toLowerCase()}</span>}
                          </span>
                        )}
                        {e.entity_type && e.entity_id && (
                          <span className="mn text-[10px] text-faint">
                            {e.entity_type}#{e.entity_id}
                          </span>
                        )}
                      </div>

                      <Meta metadata={e.metadata} />

                      <div className="mt-1 flex items-center gap-2 text-[10px] text-faint">
                        <span title={stamp(e.created_at)}>{ago(e.created_at)}</span>
                        {e.ip_address && <><span>·</span><span className="mn">{e.ip_address}</span></>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {data?.events?.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t border-hair px-3 py-1.5">
            <span className="mn text-[11px] text-faint">
              {num(page * PAGE + 1)}–{num(page * PAGE + data.events.length)} of {num(data.total)}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-[3px] border border-hair px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-faint hover:text-txt disabled:cursor-not-allowed disabled:opacity-30"
              >
                Newer
              </button>
              <button
                type="button"
                disabled={!data.has_more}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-[3px] border border-hair px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-faint hover:text-txt disabled:cursor-not-allowed disabled:opacity-30"
              >
                Older
              </button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
