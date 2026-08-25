/**
 * Evidence Locker (docs/PROJECT.md §E.9) — Scene 6.
 *
 * The page has one job: make the integrity claim CHECKABLE on screen. Files are
 * stored encrypted off-chain; the chain holds only the SHA-256 of the
 * plaintext, the case reference, the registrar and a timestamp.
 *
 * The custody trail is the centrepiece, and specifically its FAILURES. Anyone
 * can show a hash matching. The claim ARGUS actually makes is that a MISMATCH
 * is recorded on the same terms as a match and cannot be quietly removed — that
 * is the entire argument for putting this on a chain rather than in a table.
 * So a failed check is rendered louder than a passing one, not hidden behind a
 * filter.
 *
 * §F applies here too: with the RPC down, uploads still succeed and anchors sit
 * at PENDING. The status strip says so rather than the page pretending
 * everything is sealed.
 */

import { useRef, useState } from 'react';
import {
  Download, FileCheck2, Link2, Lock, ShieldAlert, ShieldCheck, Upload as UploadIcon,
} from 'lucide-react';

import { evidence as evidenceApi, chain as chainApi } from '@/api';
import { useApi, usePoll } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { Dot, Empty, Failed, Loading, Panel, Spinner } from '@/components/ui/Bits';
import { ago, elide, num, stamp } from '@/utils/format';
import { cn } from '@/lib/utils';

const ANCHOR_TONE = {
  ANCHORED: { colour: '#10b981', label: 'Anchored' },
  PENDING: { colour: '#f5a623', label: 'Pending' },
  FAILED: { colour: '#ff4757', label: 'Failed' },
};

/** The chain's own state, reported honestly whether or not it is up. */
function ChainStrip() {
  const { data, refetch } = useApi(() => chainApi.status(), []);
  usePoll(refetch, 20_000);

  const ready = data?.ready;
  return (
    <div className="glass flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
      <span className="flex items-center gap-2">
        <Dot colour={ready ? '#10b981' : '#ff4757'} size={6} pulse={!ready} />
        <span className="lbl">Registry</span>
        <span className={cn('text-[12px]', ready ? 'text-txt' : 'text-danger')}>
          {ready ? 'Connected' : 'Unavailable'}
        </span>
      </span>

      {ready ? (
        <>
          <span className="flex items-baseline gap-1.5">
            <span className="lbl">Network</span>
            <span className="mn text-[12px] text-txt">{data.network}</span>
            <span className="mn text-[10px] text-faint">chain {data.chainId}</span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="lbl">Contract</span>
            <span className="mn text-[11.5px] text-dim">{elide(data.contractAddress, 10, 8)}</span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="lbl">Registrar</span>
            <span className="mn text-[11.5px] text-dim">{elide(data.relayer, 8, 6)}</span>
          </span>
          <span className="ml-auto flex items-baseline gap-1.5">
            <span className="lbl">Digests on-chain</span>
            <span className="mn text-[15px] font-semibold text-emerald">{num(data.total_anchored)}</span>
          </span>
        </>
      ) : (
        <span className="text-[11.5px] text-faint">
          {data?.reason ?? 'checking…'} — uploads still succeed and anchors stay PENDING.
        </span>
      )}
    </div>
  );
}

/** Upload. Held in memory just long enough to hash and encrypt (§J). */
function UploadCard({ onUploaded }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('DOCUMENT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await evidenceApi.upload(file, { title: title || file.name, evidenceType: type });
      setFile(null);
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      onUploaded?.(result.evidence);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Seal new evidence">
      <form onSubmit={submit} className="flex flex-col gap-2.5">
        <label
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[3px] border border-dashed px-3 py-5 transition-colors',
            file ? 'border-blue/50 bg-blue/[0.05]' : 'border-hair hover:border-faint'
          )}
        >
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <UploadIcon className="size-4 text-faint" strokeWidth={1.5} />
          {file ? (
            <>
              <span className="truncate text-[12px] text-txt">{file.name}</span>
              <span className="mn text-[10px] text-faint">{num(file.size)} bytes</span>
            </>
          ) : (
            <>
              <span className="text-[12px] text-dim">Choose a file</span>
              <span className="text-[10px] text-faint">hashed and encrypted before it touches disk</span>
            </>
          )}
        </label>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Exhibit title (optional)"
          className="h-[28px] rounded-[3px] border border-hair bg-panel px-2 text-[12px] text-txt outline-none placeholder:text-faint focus:border-blue"
        />

        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="h-[28px] rounded-[3px] border border-hair bg-panel px-1.5 text-[12px] text-txt outline-none focus:border-blue"
        >
          {['DOCUMENT', 'SCREENSHOT', 'BANK_STATEMENT', 'CHAT_LOG', 'CALL_RECORD', 'OTHER'].map((t) => (
            <option key={t} value={t}>{t.toLowerCase().replace(/_/g, ' ')}</option>
          ))}
        </select>

        {error && <p className="text-[11px] text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!file || busy}
          className="flex h-[30px] items-center justify-center gap-2 rounded-[3px] bg-blue text-[12.5px] font-medium text-white transition-colors hover:bg-bluehi disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <><Spinner className="text-white" /> Sealing</> : <><Lock className="size-3.5" strokeWidth={2} /> Hash, encrypt &amp; anchor</>}
        </button>
        <p className="text-[10px] leading-relaxed text-faint">
          The SHA-256 is taken over the plaintext before encryption — that digest is what goes
          on-chain. Anchoring runs in the background, so a slow chain never blocks an upload.
        </p>
      </form>
    </Panel>
  );
}

/**
 * The chain of custody.
 *
 * Ordered oldest-first, and a FAILED check is given a red block rather than a
 * neutral row. This is the one place in the product where a failure is the
 * feature: if this list can show a mismatch sitting permanently beside a match,
 * the integrity claim is demonstrated rather than asserted.
 */
function CustodyTrail({ evidenceId }) {
  const { data, error, loading } = useApi(() => evidenceApi.history(evidenceId), [evidenceId]);

  if (loading) return <Loading label="Reading the chain" className="py-6" />;
  if (error) return <Failed error={error} className="py-6" />;

  if (!data?.on_chain_available) {
    return (
      <Empty
        title="Chain unavailable"
        hint={data?.on_chain_reason ?? 'The registry cannot be reached, so the custody trail cannot be read.'}
      />
    );
  }
  if (!data.on_chain.length) {
    return <Empty title="Not yet verified" hint="Run a verification to write the first custody entry." />;
  }

  return (
    <ol className="flex flex-col">
      {data.on_chain.map((v, i) => (
        <li
          key={i}
          className={cn(
            'flex items-start gap-2.5 border-b border-hair px-3 py-2.5 last:border-b-0',
            !v.matched && 'bg-danger/[0.07]'
          )}
        >
          <span className="mn mt-px w-4 shrink-0 text-[10px] text-faint">{i + 1}</span>
          {v.matched ? (
            <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald" strokeWidth={2} />
          ) : (
            <ShieldAlert className="mt-px size-3.5 shrink-0 text-danger" strokeWidth={2} />
          )}
          <div className="min-w-0 flex-1">
            <p className={cn('text-[12px]', v.matched ? 'text-txt' : 'font-semibold text-danger')}>
              {v.matched ? 'Integrity confirmed' : 'INTEGRITY FAILED'}
            </p>
            <p className="mt-0.5 text-[10.5px] text-dim">{v.note}</p>
            <p className="mn mt-1 text-[9.5px] text-faint">
              {stamp(v.checked_at)} · verifier {elide(v.verifier, 8, 6)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ExhibitDetail({ exhibit, onChanged }) {
  const { user } = useAuth();
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState(null);
  const [trailKey, setTrailKey] = useState(0);

  const canReanchor = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';
  const anchor = exhibit.anchor ?? {};
  const tone = ANCHOR_TONE[anchor.status] ?? ANCHOR_TONE.PENDING;

  async function verify() {
    setVerifying(true);
    setResult(null);
    try {
      const r = await evidenceApi.verify(exhibit.id);
      setResult(r);
      setTrailKey((k) => k + 1); // force the trail to re-read the chain
      onChanged?.();
    } catch (err) {
      setResult({ is_valid: false, note: err.message });
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <Panel
        title="Exhibit"
        right={
          <span
            className="inline-flex h-[19px] items-center gap-1.5 rounded-[2px] border px-1.5 text-[10px] font-semibold tracking-wide uppercase"
            style={{
              color: tone.colour,
              borderColor: `color-mix(in oklab, ${tone.colour} 32%, transparent)`,
              background: `color-mix(in oklab, ${tone.colour} 10%, transparent)`,
            }}
          >
            <Dot colour={tone.colour} size={5} pulse={anchor.status === 'PENDING'} />
            {tone.label}
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-txt">{exhibit.title}</h2>
            <p className="mt-0.5 text-[11px] text-faint">
              {exhibit.filename} · {num(exhibit.size_bytes)} bytes · {exhibit.evidence_type?.toLowerCase().replace(/_/g, ' ')}
              {' · '}uploaded by {exhibit.uploaded_by_name} {ago(exhibit.created_at)}
            </p>
          </div>

          {/* The digest, in full. It is the thing that is actually sealed, so it
              is never elided here — an investigator reads it against the chain. */}
          <div className="rounded-[3px] border border-hair bg-void px-2.5 py-2">
            <span className="lbl">SHA-256 of the plaintext</span>
            <p className="mn mt-1 text-[11px] leading-relaxed break-all text-emerald">
              {exhibit.sha256_hash}
            </p>
          </div>

          {anchor.tx_hash && (
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-faint">Transaction</span>
                <span className="mn truncate text-[11px] text-dim">{elide(anchor.tx_hash, 12, 10)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-faint">Block</span>
                <span className="mn text-[11px] text-dim">{num(anchor.block_number)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-faint">Anchored</span>
                <span className="text-[11px] text-dim">{stamp(anchor.anchored_at)}</span>
              </div>
              {anchor.explorer_url && (
                <a
                  href={anchor.explorer_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-bluehi hover:underline"
                >
                  View on the block explorer <Link2 className="size-2.5" />
                </a>
              )}
            </div>
          )}

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={verify}
              disabled={verifying}
              className="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[3px] bg-blue text-[12.5px] font-medium text-white transition-colors hover:bg-bluehi disabled:opacity-60"
            >
              {verifying ? <><Spinner className="text-white" /> Verifying</> : <><FileCheck2 className="size-3.5" strokeWidth={2} /> Verify integrity</>}
            </button>
            <button
              type="button"
              onClick={() => evidenceApi.download(exhibit.id, exhibit.filename)}
              title="Decrypt and download"
              className="flex size-[30px] items-center justify-center rounded-[3px] border border-hair text-dim transition-colors hover:border-faint hover:text-txt"
            >
              <Download className="size-3.5" strokeWidth={1.75} />
            </button>
            {canReanchor && anchor.status !== 'ANCHORED' && (
              <button
                type="button"
                onClick={() => evidenceApi.reanchor(exhibit.id).then(() => onChanged?.())}
                className="rounded-[3px] border border-hair px-2 text-[11.5px] text-dim transition-colors hover:border-faint hover:text-txt"
              >
                Re-anchor
              </button>
            )}
          </div>

          {/*
            The verification verdict. A failure is stated in full — the note
            names the cause, and both digests are shown so the difference is
            visible rather than asserted.
          */}
          {result && (
            <div
              className={cn(
                'rounded-[3px] border px-2.5 py-2',
                result.is_valid ? 'border-emerald/30 bg-emerald/[0.07]' : 'border-danger/40 bg-danger/[0.09]'
              )}
            >
              <p className={cn('flex items-center gap-1.5 text-[12.5px] font-semibold', result.is_valid ? 'text-emerald' : 'text-danger')}>
                {result.is_valid ? <ShieldCheck className="size-3.5" strokeWidth={2.5} /> : <ShieldAlert className="size-3.5" strokeWidth={2.5} />}
                {result.is_valid ? 'Integrity confirmed' : 'INTEGRITY FAILED'}
              </p>
              <p className="mt-1 text-[11px] text-dim">{result.note}</p>
              {result.computed_hash && result.computed_hash !== result.stored_hash && (
                <div className="mt-2 flex flex-col gap-1">
                  <div>
                    <span className="lbl">Sealed digest</span>
                    <p className="mn text-[10px] break-all text-emerald">{result.stored_hash}</p>
                  </div>
                  <div>
                    <span className="lbl">Recomputed now</span>
                    <p className="mn text-[10px] break-all text-danger">{result.computed_hash}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Chain of custody"
        subtitle="every check, permanently"
        flush
        className="min-h-0 flex-1"
      >
        <div className="h-full overflow-y-auto">
          <CustodyTrail key={trailKey} evidenceId={exhibit.id} />
        </div>
      </Panel>
    </div>
  );
}

export default function EvidenceLocker() {
  const { data, error, loading, refetch } = useApi(() => evidenceApi.list({ limit: 100 }), []);
  const [selectedId, setSelectedId] = useState(null);

  const exhibits = data?.evidence ?? [];
  const selected = exhibits.find((e) => e.id === selectedId) ?? exhibits[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <ChainStrip />

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-[300px] shrink-0 flex-col gap-3">
          <Panel
            title="Sealed exhibits"
            subtitle={data ? `${num(data.total)}` : undefined}
            flush
            className="min-h-0 flex-1"
          >
            <div className="h-full overflow-y-auto">
              {loading && !data ? (
                <Loading label="Loading" />
              ) : error ? (
                <Failed error={error} onRetry={refetch} />
              ) : !exhibits.length ? (
                <Empty title="Nothing sealed yet" hint="Upload a file to hash, encrypt and anchor it." />
              ) : (
                exhibits.map((e) => {
                  const tone = ANCHOR_TONE[e.anchor?.status] ?? ANCHOR_TONE.PENDING;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className={cn(
                        'row-hover flex w-full flex-col gap-1 border-b border-hair px-3 py-2 text-left last:border-b-0',
                        selected?.id === e.id && 'bg-raise'
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Dot colour={tone.colour} size={5} pulse={e.anchor?.status === 'PENDING'} />
                        <span className="truncate text-[12px] text-txt">{e.title}</span>
                      </div>
                      <span className="mn truncate text-[9.5px] text-faint">{elide(e.sha256_hash, 12, 8)}</span>
                      <div className="flex items-center gap-1.5 text-[10px] text-faint">
                        <span>{ago(e.created_at)}</span>
                        {e.verification_count > 0 && (
                          <>
                            <span>·</span>
                            <span>{e.verification_count} check{e.verification_count === 1 ? '' : 's'}</span>
                          </>
                        )}
                        {e.complaint_ref && (
                          <>
                            <span>·</span>
                            <span className="mn">{e.complaint_ref}</span>
                          </>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </Panel>

          <UploadCard onUploaded={(ev) => { refetch(); setSelectedId(ev.id); }} />
        </div>

        {selected ? (
          <ExhibitDetail exhibit={selected} onChanged={refetch} />
        ) : (
          <Panel className="flex-1">
            <Empty
              icon={Lock}
              title="No exhibit selected"
              hint="Seal a file to see its digest, its anchor and its full chain of custody."
              className="my-auto"
            />
          </Panel>
        )}
      </div>
    </div>
  );
}
