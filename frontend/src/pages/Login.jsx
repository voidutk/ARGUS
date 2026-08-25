/**
 * The authentication gate (docs/PROJECT.md §E.1).
 *
 * Composition is a deliberate 50/50 split rather than a centred card on a
 * background. The India-at-night canvas is the product's one piece of ambience
 * and it earns a real half of the screen; a card floating over a blurred
 * backdrop is the default every template ships with, and it would make the
 * canvas decorative instead of meaningful.
 *
 * The form half stays flat and quiet — no gradients, no glow, one accent — so
 * the first impression is an instrument, not a landing page.
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';

import { useAuth } from '@/context/AuthContext';
import { mount } from '@/components/map/indiaNight';
import { Spinner } from '@/components/ui/Bits';

/** Seeded accounts (docs/PROJECT.md §P). Filling the form beats typing on stage. */
const DEMO_ACCOUNTS = [
  { email: 'investigator@argus.gov.in', role: 'Investigator', note: 'Case work and evidence' },
  { email: 'analyst@argus.gov.in', role: 'Analyst', note: 'Graph analytics' },
  { email: 'supervisor@argus.gov.in', role: 'Supervisor', note: 'Oversight and assignment' },
  { email: 'admin@argus.gov.in', role: 'Admin', note: 'Full control' },
];

const DEMO_PASSWORD = 'argus2026';

function NightCanvas() {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    // mount() returns its own disposer — it owns the rAF loop, the resize
    // observer and the visibility listener, so React just has to call it.
    const dispose = mount(ref.current, { centerX: 0.52 });
    return dispose;
  }, []);

  return <canvas ref={ref} className="absolute inset-0 size-full" aria-hidden="true" />;
}

export default function Login() {
  const { user, loading: bootLoading, login, errorMessage } = useAuth();
  const [email, setEmail] = useState(DEMO_ACCOUNTS[0].email);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!bootLoading && user) return <Navigate to="/" replace />;

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden bg-void lg:grid-cols-[1.15fr_1fr]">
      {/* ---- ambience ---- */}
      <div className="relative hidden overflow-hidden border-r border-hair lg:block">
        <NightCanvas />

        {/* A single soft vignette toward the seam so the canvas resolves into
            the form rather than being cut off by a hard edge. */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,transparent_55%,rgba(8,11,18,0.85)_100%)]" />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-8">
          <p className="max-w-[46ch] text-[15px] leading-relaxed font-light text-txt/85">
            Every cybercrime complaint is filed alone.
            <br />
            <span className="text-txt">They are not committed alone.</span>
          </p>
          <p className="mt-3 max-w-[52ch] text-[11.5px] leading-relaxed text-dim">
            ARGUS correlates identifiers across filings to expose the organisation behind them —
            and names the coordinator no single victim ever met.
          </p>
        </div>
      </div>

      {/* ---- form ---- */}
      <div className="flex items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-[340px]">
          <div className="mb-8 flex items-center gap-2.5">
            <span className="relative flex size-[22px] items-center justify-center">
              <span className="absolute inset-0 rounded-[3px] border border-blue/60" />
              <span className="size-[7px] rounded-[1px] bg-blue" />
            </span>
            <div className="flex flex-col">
              <span className="text-[15px] leading-none font-semibold tracking-[0.16em] text-txt">ARGUS</span>
              <span className="mt-1 text-[9px] leading-none tracking-[0.12em] text-faint uppercase">
                Cybercrime Intelligence Platform
              </span>
            </div>
          </div>

          <h1 className="text-[19px] leading-tight font-semibold text-txt">Sign in</h1>
          <p className="mt-1.5 text-[12px] text-dim">Authorised personnel only. All access is logged.</p>

          <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Official email</span>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9 rounded-[3px] border border-hair bg-panel px-2.5 text-[13px] text-txt transition-colors outline-none placeholder:text-faint focus:border-blue"
                placeholder="name@argus.gov.in"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="lbl">Password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mn h-9 rounded-[3px] border border-hair bg-panel px-2.5 text-[13px] text-txt transition-colors outline-none placeholder:text-faint focus:border-blue"
                placeholder="••••••••"
              />
            </label>

            {/* Reserved height so a failure does not shift the button under the
                cursor mid-click. */}
            <div className="min-h-[16px]">
              {error && <p className="text-[11.5px] leading-tight text-danger">{error}</p>}
            </div>

            <button
              type="submit"
              disabled={busy}
              className="group flex h-9 items-center justify-center gap-2 rounded-[3px] bg-blue text-[13px] font-medium text-white transition-colors hover:bg-bluehi disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Spinner className="text-white" />
                  Signing in
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
                </>
              )}
            </button>
          </form>

          <div className="mt-8">
            <div className="rule mb-4" />
            <p className="lbl mb-2.5">Demo accounts</p>
            <div className="flex flex-col gap-px">
              {DEMO_ACCOUNTS.map((account) => {
                const active = email === account.email;
                return (
                  <button
                    key={account.email}
                    type="button"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(DEMO_PASSWORD);
                      setError(null);
                    }}
                    className={`flex items-center justify-between gap-3 rounded-[3px] px-2 py-1.5 text-left transition-colors ${
                      active ? 'bg-raise' : 'hover:bg-raise/50'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className={`truncate text-[12px] ${active ? 'text-txt' : 'text-dim'}`}>
                        {account.role}
                      </span>
                      <span className="mn truncate text-[10px] text-faint">{account.email}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-faint">{account.note}</span>
                  </button>
                );
              })}
            </div>
            <p className="mn mt-3 flex items-center gap-1.5 text-[10px] text-faint">
              <Lock className="size-3" strokeWidth={1.75} />
              password · {DEMO_PASSWORD}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
