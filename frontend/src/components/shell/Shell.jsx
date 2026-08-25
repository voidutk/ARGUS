/**
 * The application frame: rail, header, outlet.
 *
 * Layout intent — a fixed 208px rail and a 44px header, both hairline-bounded,
 * with the page owning everything else. The chrome is deliberately thin: this
 * is a tool where the content is a graph or a dense table, and every pixel the
 * frame takes is one the data does not get. Compare a typical admin template,
 * which spends 64px on a header to hold a logo and an avatar.
 *
 * The rail groups by INVESTIGATIVE INTENT rather than by data model. "Where is
 * it happening" (Geo) sits with "who is doing it" (Network) because that is how
 * an analyst moves between them, not because they share a table.
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity, Boxes, CircleAlert, Coins, FileSearch, Gauge, Globe2,
  History, LogOut, Network, Server, ShieldCheck,
} from 'lucide-react';

import { useAuth } from '@/context/AuthContext';
import { useApi, usePoll } from '@/hooks/useApi';
import { admin } from '@/api';
import { Dot } from '@/components/ui/Bits';
import { cn } from '@/lib/utils';

const SECTIONS = [
  {
    label: 'Overview',
    items: [{ to: '/', end: true, icon: Gauge, label: 'Dashboard' }],
  },
  {
    label: 'Investigate',
    items: [
      { to: '/network', icon: Network, label: 'Network Explorer' },
      { to: '/complaints', icon: FileSearch, label: 'Complaints' },
      { to: '/money', icon: Coins, label: 'Money Flow' },
      { to: '/geo', icon: Globe2, label: 'Geo Intelligence' },
    ],
  },
  {
    label: 'Monitor',
    items: [
      { to: '/alerts', icon: CircleAlert, label: 'Threat Feed' },
      { to: '/timeline', icon: History, label: 'Timeline' },
      { to: '/clusters', icon: Boxes, label: 'Networks' },
    ],
  },
  {
    label: 'Custody',
    items: [
      { to: '/evidence', icon: ShieldCheck, label: 'Evidence Locker' },
      { to: '/admin', icon: Server, label: 'Admin' },
    ],
  },
];

/**
 * The four-service status strip.
 *
 * It is in the header rather than buried on the Admin page because §F's whole
 * argument is that this platform degrades visibly instead of silently. If the
 * AI service is down, the person reading a graph should know before they draw a
 * conclusion from it — not after.
 */
function ServiceStatus() {
  const { data, refetch } = useApi(() => admin.health(), []);
  usePoll(refetch, 20_000);

  const services = [
    { key: 'postgres', label: 'DB', state: data?.postgres },
    { key: 'intel', label: 'AI', state: data?.intel },
    { key: 'neo4j', label: 'Graph', state: data?.neo4j },
    { key: 'chain', label: 'Chain', state: data?.chain },
  ];

  return (
    <div className="hidden items-center gap-3 md:flex">
      {services.map((s) => {
        const ok = s.state?.ok;
        return (
          <span
            key={s.key}
            className="flex items-center gap-1.5"
            title={`${s.label}: ${s.state?.detail ?? 'checking…'}`}
          >
            <Dot
              colour={ok === undefined ? '#556074' : ok ? '#10b981' : '#ff4757'}
              pulse={ok === false}
              size={5}
            />
            <span className={cn('text-[10px] font-medium tracking-wide', ok ? 'text-faint' : 'text-dim')}>
              {s.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function RailLink({ to, end, icon: Icon, label }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group relative flex h-8 items-center gap-2.5 rounded-[3px] px-2.5 text-[12.5px] transition-colors',
          isActive ? 'bg-raise text-txt' : 'text-dim hover:bg-raise/50 hover:text-txt'
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* A 2px spine on the active item — enough to locate at a glance,
              quiet enough not to compete with the content. */}
          <span
            className={cn(
              'absolute top-1.5 bottom-1.5 -left-px w-[2px] rounded-full transition-opacity',
              isActive ? 'bg-blue opacity-100' : 'opacity-0'
            )}
          />
          <Icon className="size-[15px] shrink-0" strokeWidth={1.75} />
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Shell() {
  const { user, logout } = useAuth();
  const location = useLocation();

  const current = SECTIONS.flatMap((s) => s.items).find((i) =>
    i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-void">
      {/* ---- rail ---- */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-hair bg-deep">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hair px-3">
          {/* The mark: a filled square inside a ring — an eye, abstracted.
              A literal eye glyph would read as surveillance branding, which is
              the wrong note for a police correlation tool. */}
          <span className="relative flex size-[18px] items-center justify-center">
            <span className="absolute inset-0 rounded-[3px] border border-blue/60" />
            <span className="size-[6px] rounded-[1px] bg-blue" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] leading-none font-semibold tracking-[0.14em] text-txt">ARGUS</span>
            <span className="mt-[3px] text-[8.5px] leading-none tracking-[0.1em] text-faint uppercase">
              Cybercrime Intelligence
            </span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {SECTIONS.map((section) => (
            <div key={section.label} className="mb-4 last:mb-0">
              <p className="lbl mb-1.5 px-2.5">{section.label}</p>
              <div className="flex flex-col gap-px">
                {section.items.map((item) => (
                  <RailLink key={item.to} {...item} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* ---- identity ---- */}
        <div className="shrink-0 border-t border-hair p-2">
          <div className="flex items-center gap-2 rounded-[3px] px-1.5 py-1.5">
            <span className="mn flex size-7 shrink-0 items-center justify-center rounded-[3px] border border-hair bg-raise text-[11px] font-semibold text-dim">
              {(user?.full_name ?? '?')
                .split(' ')
                .map((p) => p[0])
                .slice(0, 2)
                .join('')
                .toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12px] leading-tight font-medium text-txt">
                {user?.full_name ?? '—'}
              </span>
              <span className="truncate text-[10px] leading-tight text-faint">
                {user?.rank_title || user?.role} · {user?.unit_code ?? 'UNASSIGNED'}
              </span>
            </div>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className="shrink-0 rounded-[3px] p-1.5 text-faint transition-colors hover:bg-raise hover:text-danger"
            >
              <LogOut className="size-[13px]" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </aside>

      {/* ---- main ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-hair bg-deep px-4">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[13px] font-medium text-txt">{current?.label ?? 'ARGUS'}</h1>
          </div>
          <div className="flex items-center gap-4">
            <ServiceStatus />
            <span className="hidden items-center gap-1.5 lg:flex">
              <Activity className="size-3 text-emerald" strokeWidth={2} />
              <span className="text-[10px] tracking-wide text-faint uppercase">Live</span>
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
