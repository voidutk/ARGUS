/**
 * Admin (docs/PROJECT.md §E.10).
 *
 * The service board is the point. §F's entire argument is that this platform
 * degrades VISIBLY — so there has to be one screen that says, without
 * interpretation, which of the five components are answering and which are not.
 * A green row here is a claim that can be checked by turning the service off.
 *
 * Users and the alert-rule catalogue sit alongside because they are the other
 * two things an administrator needs to be able to audit: who has access, and
 * what the system is watching for.
 */

import { Link } from 'react-router-dom';
import { Server, ShieldCheck, Users } from 'lucide-react';

import { admin as adminApi, alerts as alertsApi, osint as osintApi } from '@/api';
import { useApi, usePoll } from '@/hooks/useApi';
import { Dot, Empty, Failed, Loading, Panel } from '@/components/ui/Bits';
import { dateOnly } from '@/utils/format';
import { cn } from '@/lib/utils';

const SERVICES = [
  { key: 'postgres', label: 'PostgreSQL', note: 'Records — the source of truth' },
  { key: 'intel', label: 'Intelligence service', note: 'Extraction and the Neo4j projection' },
  { key: 'neo4j', label: 'Neo4j', note: 'Derived graph index' },
  { key: 'chain', label: 'Evidence registry', note: 'On-chain custody' },
  { key: 'reference_data', label: 'NCRB reference data', note: 'Official statistics layer' },
];

function ServiceBoard() {
  const { data, error, loading, refetch } = useApi(() => adminApi.health(), []);
  usePoll(refetch, 15_000);

  if (loading && !data) return <Loading label="Probing services" />;
  if (error) return <Failed error={error} onRetry={refetch} />;

  return (
    <div className="flex flex-col">
      {SERVICES.map((s) => {
        const state = data?.[s.key];
        const ok = state?.ok;
        return (
          <div key={s.key} className="flex items-center gap-3 border-b border-hair px-3 py-2.5 last:border-b-0">
            <Dot colour={ok ? '#10b981' : '#ff4757'} size={7} pulse={!ok} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] text-txt">{s.label}</span>
                <span
                  className={cn('text-[10px] font-semibold tracking-wide uppercase', ok ? 'text-emerald' : 'text-danger')}
                >
                  {ok ? 'up' : 'down'}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[10.5px] text-faint">{state?.detail ?? s.note}</p>
            </div>
            {/*
              A degraded-but-healthy service says so. The intel circuit is
              "closed" when calls are flowing and "open" when the breaker has
              stopped dialling — worth surfacing, because an open breaker
              explains a fallback that would otherwise look like a bug.
            */}
            {s.key === 'intel' && state?.circuit && (
              <span className="mn shrink-0 text-[10px] text-faint">circuit {state.circuit}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UserTable() {
  const { data, error, loading } = useApi(() => adminApi.users(), []);

  if (loading) return <Loading label="Loading users" />;
  // A non-admin gets a 403 here, which is the system working, not a failure to
  // report as one.
  if (error?.status === 403) {
    return <Empty icon={Users} title="Not permitted" hint="User administration requires the ADMIN or SUPERVISOR role." />;
  }
  if (error) return <Failed error={error} />;

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-hair">
          {['Name', 'Role', 'Unit', 'Status', 'Since'].map((h) => (
            <th key={h} className="lbl px-3 py-1.5 font-semibold">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(data?.users ?? []).map((u) => (
          <tr key={u.id} className="row-hover border-b border-hair last:border-b-0">
            <td className="px-3 py-2">
              <span className="text-[12px] text-txt">{u.full_name}</span>
              <span className="mn ml-1.5 text-[10px] text-faint">{u.email}</span>
            </td>
            <td className="px-3 py-2 text-[11px] text-dim">
              {u.rank_title && <span className="text-faint">{u.rank_title} · </span>}
              {u.role}
            </td>
            <td className="px-3 py-2 text-[11px] text-dim">{u.unit_code ?? '—'}</td>
            <td className="px-3 py-2">
              <span className={cn('text-[11px]', u.is_active ? 'text-emerald' : 'text-faint')}>
                {u.is_active ? 'active' : 'disabled'}
              </span>
            </td>
            <td className="px-3 py-2 text-[10.5px] whitespace-nowrap text-faint">{dateOnly(u.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The rules, with their thresholds — declared so the feed can be trusted. */
function RuleCatalogue() {
  const { data, loading } = useApi(() => alertsApi.rules(), []);
  if (loading) return <Loading label="Loading rules" />;

  return (
    <div className="flex flex-col">
      {(data?.rules ?? []).map((r) => (
        <div key={r.key} className="border-b border-hair px-3 py-2 last:border-b-0">
          <div className="flex items-center justify-between gap-2">
            <span className="mn text-[11px] text-txt">{r.key}</span>
            <div className="flex flex-wrap items-center gap-1">
              {Object.entries(r.thresholds ?? {}).map(([k, v]) => (
                <span key={k} className="mn rounded-[2px] border border-hair bg-raise/50 px-1 text-[9.5px] text-faint">
                  {k.replace(/^min/, '≥').replace(/^max/, '≤')} {v}
                </span>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-[10.5px] text-dim">{r.title}</p>
        </div>
      ))}
      {data?.note && (
        <p className="px-3 py-2 text-[9.5px] leading-relaxed text-faint">{data.note}</p>
      )}
    </div>
  );
}

/** OSINT adapters, with the integrity rule stated. */
function AdapterList() {
  const { data, loading } = useApi(() => osintApi.adapters(), []);
  if (loading) return <Loading label="Loading adapters" />;

  return (
    <div className="flex flex-col">
      {(data?.adapters ?? []).map((a) => (
        <div key={a.key} className="flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-b-0">
          <div className="min-w-0 flex-1">
            <span className="text-[11.5px] text-txt">{a.label}</span>
            <p className="truncate text-[10px] text-faint">accepts {a.accepts.join(', ')}</p>
          </div>
          <span
            className="shrink-0 rounded-[2px] border px-1 text-[9px] font-semibold tracking-wider uppercase"
            style={{
              color: a.simulated ? '#f5a623' : '#10b981',
              borderColor: a.simulated ? 'rgba(245,166,35,0.3)' : 'rgba(16,185,129,0.3)',
              background: a.simulated ? 'rgba(245,166,35,0.08)' : 'rgba(16,185,129,0.08)',
            }}
          >
            {a.simulated ? 'Simulated' : 'Live'}
          </span>
        </div>
      ))}
      {data?.integrity_rule && (
        <p className="px-3 py-2 text-[9.5px] leading-relaxed text-faint">{data.integrity_rule}</p>
      )}
    </div>
  );
}

export default function Admin() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel title="Service health" subtitle="probed live" flush right={<Server className="size-3 text-faint" strokeWidth={1.75} />}>
          <ServiceBoard />
        </Panel>

        <Panel title="Alert rules" subtitle="thresholds in the open" flush right={<ShieldCheck className="size-3 text-faint" strokeWidth={1.75} />}>
          <RuleCatalogue />
        </Panel>
      </div>

      <Panel title="Users" flush right={<Users className="size-3 text-faint" strokeWidth={1.75} />}>
        <UserTable />
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel title="OSINT adapters" flush>
          <AdapterList />
        </Panel>

        <Panel title="Operations">
          <div className="flex flex-col gap-2 text-[11.5px]">
            <Link to="/timeline" className="text-bluehi transition-colors hover:text-txt">
              Investigation timeline — the append-only record
            </Link>
            <Link to="/alerts" className="text-bluehi transition-colors hover:text-txt">
              Threat feed — re-run the rules
            </Link>
            <Link to="/evidence" className="text-bluehi transition-colors hover:text-txt">
              Evidence locker — chain of custody
            </Link>
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              Graph rebuild and analytics recomputation are triggered from the Networks page, where
              their effect is visible.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
