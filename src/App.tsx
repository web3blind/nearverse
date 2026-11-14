import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useFinancialActivation } from './sdk/financialActivation';
import { SystemIllustration } from './SystemIllustration';
import { canon, getSystem, regions, systems, type Asset } from './world';
import { gameStorage, makeEvent, progress, scopeKey, MAX_EXPORT_BYTES, type GameEvent, type GameSave, type HistoryTransport, type Scope, type Ship } from './storage';
import './style.css';

async function request(path: string, account: string, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-Nearverse-Account': account }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.ok && response.status === 409 && (await response.clone().json()).error === 'account_changed') throw new Error('This history session belongs to another account. Sign in again.');
  if (!response.ok) throw new Error(response.status === 401 ? 'History requires a separate sign-in to verify wallet ownership. Connecting an address does not sign you in.' : `History has not synced (HTTP ${response.status}). Your actions remain in the local queue.`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_EXPORT_BYTES) throw new Error('The history response is too large.');
  return JSON.parse(text) as Record<string, unknown>;
}
export const historyTransport: HistoryTransport = {
  async read(account) {
    const result = await request('/api/journal', account);
    if (result.accountId !== account || !Array.isArray(result.events)) throw new Error('This history session belongs to another account. Sign in again.');
    return result.events as GameEvent[];
  },
  async append(account, event) {
    // Arrival proofs are exclusively submitted by the financial bridge, not this local queue.
    if (event.type === 'arrival' || event.type === 'visit') throw new Error('A local arrival cannot be synced.');
    const session = await request('/api/auth/session', account);
    if (session.accountId !== account) throw new Error('Sign in securely to access history for this account first.');
    const result = await request('/api/events', account, { eventId: event.eventId, type: event.type, systemId: event.systemId, storyId: event.storyId });
    const currentSession = await request('/api/auth/session', account);
    if (currentSession.accountId !== account) throw new Error('The history account has changed. The event has not been confirmed locally.');
    return result.event as GameEvent;
  },
};

export function ShipArt({ art }: { art: Ship['art'] }) {
  return <svg className="ship-art" viewBox="0 0 480 260" role="img" aria-label={`Built-in ship illustration: ${art === 'sail' ? 'solar sail' : art === 'surveyor' ? 'explorer' : 'courier'}`}>
    <g fill="none" stroke="currentColor" opacity=".22"><ellipse cx="240" cy="155" rx="210" ry="67"/><path d="M16 155h448M240 30v220"/><circle cx="240" cy="135" r="98"/></g>
    <g stroke="#b8c9cb" strokeWidth="2" strokeLinejoin="round">
      {art === 'sail' ? <><path d="M240 35 84 184l150-35z" fill="#708b87"/><path d="m248 35 148 149-142-35z" fill="#3e575b"/><path d="m240 85-12 126h28L248 85z" fill="#d8e4df"/></> : <><path d="m240 49-45 107-91 47 113-13 23 33 23-33 113 13-91-47z" fill="#4c6269"/><path d="m240 49-17 126 17 31 17-31z" fill="#b7c9c7"/><path d="m204 135-36 44 39-11m69-33 36 44-39-11" fill="#80938f"/>{art === 'surveyor' && <><circle cx="154" cy="146" r="28" fill="#273e46"/><circle cx="326" cy="146" r="28" fill="#273e46"/><path d="M154 118v56m172-56v56"/></>}</>}
      <path d="m232 185 8 22 8-22" fill="#e5bd81" stroke="#e5bd81"/><path d="m236 104 4-16 4 16" fill="#172b35" stroke="#172b35"/>
    </g><g fill="#e5bd81"><circle cx="81" cy="64" r="2"/><circle cx="409" cy="102" r="2"/><circle cx="379" cy="218" r="1.5"/></g>
  </svg>;
}
function MapArt({ selected }: { selected: string }) {
  return <svg className="galaxy" viewBox="0 0 1000 560" role="img" aria-labelledby="map-title map-desc">
    <title id="map-title">NearVerse region map: {regions.length}</title><desc id="map-desc">Systems on the map: {systems.length}. The same destinations are available as buttons in the list immediately after the map. Selected system: {getSystem(selected).name}.</desc>
    <defs><pattern id="stars" width="91" height="73" patternUnits="userSpaceOnUse"><circle cx="12" cy="19" r="1" fill="#7b919c"/><circle cx="66" cy="55" r=".7" fill="#81969d"/></pattern></defs>
    <rect width="1000" height="560" fill="url(#stars)"/>
    <g fill="none" stroke="#3b515c"><ellipse cx="500" cy="280" rx="405" ry="180" transform="rotate(-18 500 280)"/><ellipse cx="500" cy="280" rx="298" ry="116" transform="rotate(-18 500 280)"/>
      <path d="M190 151 360 84 690 106 840 218 860 465 720 370 460 470 280 380 190 151" strokeDasharray="4 8"/>
    </g>
    {systems.map(system => <g key={system.id} transform={`translate(${system.x * 10} ${system.y * 5.6})`}>
      <circle r={system.id === selected ? 19 : 10} fill="#152e39" stroke={system.id === selected ? '#e5bd81' : '#8ca9af'} strokeWidth="2"/>
      <circle r="3" fill="#e5bd81"/><text y="-27" textAnchor="middle" fill="#eff3ef" fontSize="17">{system.name}</text><text y="36" textAnchor="middle" fill="#b1c2c7" fontSize="12">{system.asset}</text>
    </g>)}
  </svg>;
}
const labels: Record<GameEvent['type'], string> = { visit: 'Practice arrival', arrival: 'Confirmed arrival', 'expedition.started': 'Expedition started', 'expedition.completed': 'Expedition completed', 'story.read': 'Story unlocked' };
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Could not save your data. Check browser storage permissions.'; }

export function App() {
  const {Panel:FinancialPanel,activate,loading:walletLoading,error:walletError,connectRequest,recovery,activationRecoveryBlocked,activationRecoveryEntries,onRecoveryActivated} = useFinancialActivation();
  const [mode, setMode] = useState<Scope['mode']>('real');
  const [account, setAccount] = useState<string | null>(null);
  const [selected, setSelected] = useState('near-lada');
  const [save, setSave] = useState<GameSave | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState<Ship | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [showDeleteJournal,setShowDeleteJournal] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const systemHeading = useRef<HTMLHeadingElement>(null);
  const scope: Scope = { mode, account: mode === 'preview' ? null : account };
  const key = scopeKey(scope);
  const scopeRef = useRef(key); scopeRef.current = key;
  const saveRef = useRef(save); saveRef.current = save;
  const work = useRef(false);
  const preview = mode === 'preview';
  const system = getSystem(selected);
  const current = save ? progress(save, selected) : null;
  // Real progress is visible only after the server acknowledges its events.
  const visibleSave = save && !preview ? { ...save, events: save.events.filter(event => !save.queue.includes(event.eventId)) } : save;
  const visible = visibleSave ? progress(visibleSave, selected) : null;
  const canPlay = preview || (!!account && synced);
  const otherExpedition = save?.events.find(event => event.type === 'expedition.started' && event.systemId !== selected && !save.events.some(done => done.type === 'expedition.completed' && done.storyId === event.storyId));
  const readyAt = current?.active ? (current.active.readyAt ?? current.active.createdAt + (current.next?.durationSeconds ?? 0) * 1000) : 0;
  const seconds = Math.max(0, Math.ceil((readyAt - now) / 1000));

  const sync = useCallback(async (target: Scope) => {
    const targetKey = scopeKey(target);
    try {
      const next = await gameStorage.sync(target, historyTransport);
      if (scopeRef.current === targetKey) { setSave(next); setSynced(true); setError(''); setNotice('History confirmed by the server.'); }
    } catch (cause) {
      if (scopeRef.current === targetKey) { setSynced(false); setError(errorMessage(cause)); }
    }
  }, []);
  useEffect(() => {
    let live = true;
    setSave(null); setDraft(null); setError(''); setNotice(''); setSynced(false); setShowReset(false);setShowDeleteJournal(false);
    gameStorage.load(scope).then(next => {
      if (!live) return;
      setSave(next);
      if (scope.mode === 'real' && scope.account) void sync(scope);
    }).catch(cause => { if (live) setError(`Local storage is unavailable or corrupted: ${errorMessage(cause)}. Progress has not been saved. Enable IndexedDB and reload the page.`); });
    return () => { live = false; };
  // key is the complete storage namespace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sync]);
  useEffect(() => {
    const retry = () => { if (scope.mode === 'real' && scope.account) void sync(scope); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sync]);
  useEffect(() => {
    if (!current?.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current?.active?.eventId]);

  async function act(task: (target: Scope) => Promise<GameSave>, message: string, needsSync = false) {
    if (work.current) return false;
    const target = { ...scope }; const targetKey = key;
    work.current = true; setBusy(true); setError('');
    try {
      const next = await task(target);
      if (scopeRef.current === targetKey) { setSave(next); setNotice(message); }
      if (needsSync && target.mode === 'real' && target.account) await sync(target);
      return true;
    } catch (cause) { if (scopeRef.current === targetKey) setError(errorMessage(cause)); return false; }
    finally { work.current = false; setBusy(false); }
  }
  async function expedition() {
    if (!canPlay || !current?.next || otherExpedition) return;
    if (!current.active) {
      const event = makeEvent('expedition.started', system.id, current.next.id);
      await act(target => gameStorage.append(target, event), preview ? 'Practice expedition started. You can close this page: the timer and progress are saved.' : 'Expedition start queued. Waiting for the server timestamp.', true);
      setNow(Date.now());
      return;
    }
    if (seconds > 0) return;
    const storyId = current.next.id; const systemId = system.id;
    await act(async target => {
      // A queued completion may be retried with its existing id rather than submitted again.
      let latest = await gameStorage.load(target);
      if (!latest.events.some(event => event.type === 'expedition.completed' && event.storyId === storyId)) latest = await gameStorage.append(target, makeEvent('expedition.completed', systemId, storyId));
      if (target.mode === 'real') latest = await gameStorage.sync(target, historyTransport);
      return gameStorage.append(target, makeEvent('story.read', systemId, storyId));
    }, 'Expedition complete. Entry added to the journal.', true);
  }
  function choose(id: string) {
    setSelected(id); setNotice(`Selected beacon: ${getSystem(id).name}.`);
    window.requestAnimationFrame(() => systemHeading.current?.focus());
  }
  function closeShipEditor() {
    setDraft(null);
    window.requestAnimationFrame(() => document.getElementById('ship-edit')?.focus());
  }
  function updateShip(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    void act(target => gameStorage.saveShip(target, draft), 'Ship saved on this device only.').then(saved => { if (saved && scopeRef.current === key) closeShipEditor(); });
  }
  async function deleteJournal() {
    if(preview || !account) return;
    const owner = account;
    await act(async target => {
      const response = await fetch('/api/journal',{method:'DELETE',headers:{'Content-Type':'application/json','X-Nearverse-Account':owner},body:'{}'});
      if(!response.ok) throw new Error('The server has not confirmed deletion. Your local journal has been kept.');
      const remaining = await historyTransport.read(owner);
      if(remaining.length) throw new Error('The journal check did not confirm deletion.');
      localStorage.setItem(`nearverse:journal-deleted:${owner}`,crypto.randomUUID());
      window.dispatchEvent(new CustomEvent('nearverse:journal-deleted',{detail:{accountId:owner}}));
      setShowDeleteJournal(false);return gameStorage.clearHistory(target);
    },'Server journal deleted. Ship settings remain on this device.');
  }
  async function download() {
    try {
      const raw = await gameStorage.export(scope);
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `nearverse-${preview ? 'preview' : account ?? 'guest'}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Local save exported. The file contains no keys or signatures.');
    } catch (cause) { setError(errorMessage(cause)); }
  }
  return <div className="app-shell" lang="en">
    <a href="#main" className="skip-link">Skip to main content</a>
    <header className="site-header"><a className="brand" href="#main"><span className="brand-mark" aria-hidden="true">N/</span> NEARVERSE</a><nav aria-label="Sections"><a href="#star-map">Map</a><a href="#converter">Converter</a><a href="#journal">Journal</a></nav><button type="button" disabled={walletLoading || preview} onClick={()=>void activate()}>{walletLoading?'Loading NEAR wallet…':account?'Open NEAR wallet selector':'Connect NEAR wallet'}</button><span className="edition">ONBOARD ATLAS / 01</span></header>
    <div role="status" aria-live="polite">{walletLoading?'Loading the wallet module. The NEAR wallet selector will open automatically.':!FinancialPanel && recovery.blocked?recovery.message:''}</div>{walletError && <div><p role="alert">{walletError}</p><button type="button" onClick={()=>window.location.reload()}>Reload page to retry wallet connection</button></div>}
    <main id="main" tabIndex={-1}>
      <section className="intro" aria-labelledby="intro-title"><div><p className="eyebrow">Borders are an invitation</p><h1 id="intro-title">Every beacon<br/>{' '}has a story.</h1><p className="intro-copy">Choose a thread between worlds. Stay to hear from the people who live there.</p></div><div className="mode-switch"><span className="eyebrow">Flight mode</span><div className="segmented" role="group" aria-label="Flight mode"><button type="button" aria-pressed={!preview} onClick={() => setMode('real')}>Live</button><button type="button" aria-pressed={preview} onClick={() => setMode('preview')}>Isolated preview</button></div><p>{preview ? 'A practice world with no wallet or swaps. Progress is separate and never enters your live history.' : 'Real transactions require your explicit approval. Sign in securely to save your history.'}</p></div></section>
      {preview && <div className="preview-banner"><strong>PREVIEW · Practice space</strong><span>All arrivals and expeditions here are simulated. Real financial transactions are disabled.</span></div>}
      <div className="feedback"><p role="status" aria-atomic="true">{notice || (save ? preview ? 'Practice progress is stored on this device.' : account ? `Account: ${account}. ${synced ? 'History synced.' : 'History has not synced yet.'}` : 'Live mode. No wallet connected. Connect a NEAR wallet to swap and save your history, or switch to Isolated preview to practise without a wallet.' : 'Loading local journal…')}</p>{error && <p role="alert" className="error">{error}</p>}</div>
      <div className="cockpit-grid">
        <section className="map-panel panel" id="star-map" aria-labelledby="map-heading"><div className="section-heading"><div><p className="eyebrow">01 / Navigation</p><h2 id="map-heading">Atlas of passage threads</h2></div><span className="small-label">Regions: {regions.length} · systems: {systems.length}</span></div><MapArt selected={selected}/><p className="map-note">This map provides an overview. You can also select any beacon from the accessible destination list.</p><div className="region-list">{regions.map(region => <section key={region.asset} className="region" aria-labelledby={`region-${region.asset}`}><h3 id={`region-${region.asset}`}><span>{region.asset}</span> {region.name}</h3><p>{region.description}</p><ul>{systems.filter(item => item.asset === region.asset).map(item => <li key={item.id}><button type="button" aria-pressed={item.id === selected} onClick={() => choose(item.id)}><span>{item.name}</span>{' '}<span>{item.subtitle}</span>{' '}<span className="beacon-state">{visibleSave && progress(visibleSave, item.id).visited ? 'Available' : 'Beacon'}</span></button></li>)}</ul></section>)}</div></section>
        <aside className="ship-panel panel" aria-labelledby="ship-heading"><p className="eyebrow">02 / Your ship</p><h2 id="ship-heading">{save?.ship.name ?? 'Ship profile'}</h2><ShipArt art={draft?.art ?? save?.ship.art ?? 'courier'}/>{save && !draft && <><p className="biography">{save.ship.biography || 'This ship has no biography yet. Write the first line.'}</p><button id="ship-edit" type="button" className="secondary" onClick={() => setDraft({ ...save.ship })}>Edit ship</button><p className="hint">The name, biography and built-in illustration are stored only in this browser.</p></>}{draft && <form onSubmit={updateShip}><label htmlFor="ship-name">Ship name</label><input id="ship-name" required maxLength={60} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/><label htmlFor="ship-bio">Biography</label><textarea id="ship-bio" rows={5} maxLength={2000} value={draft.biography} onChange={event => setDraft({ ...draft, biography: event.target.value })}/><label htmlFor="ship-art">Built-in design</label><select id="ship-art" value={draft.art} onChange={event => setDraft({ ...draft, art: event.target.value as Ship['art'] })}><option value="courier">Mail courier</option><option value="surveyor">Deep-space explorer</option><option value="sail">Solar sail</option></select><div className="actions"><button disabled={busy}>Save ship</button><button type="button" className="secondary" onClick={closeShipEditor}>Cancel</button></div></form>}<div className="ship-log"><span className="eyebrow">Propellant</span><p>{regions.find(region => region.asset === system.asset)?.material}</p><span className="hint">Fictional description, not your wallet balance.</span></div></aside>
      </div>
      <div className="journey-grid">
        <section className="system-panel panel" aria-labelledby="system-heading"><p className="eyebrow">03 / Selected beacon · {system.asset}</p><h2 id="system-heading" ref={systemHeading} tabIndex={-1}>{system.name}{' '}<span className="heading-sub">{system.subtitle}</span></h2><p>{system.description}</p><dl className="system-facts"><div><dt>Planet</dt><dd>{system.planet}</dd></div><div><dt>Stories</dt><dd>{system.stories.length} in sequence</dd></div><div><dt>Exploration</dt><dd>{visible?.visited ? 'Available' : 'After arrival'}</dd></div></dl>
          {visible?.visited && <SystemIllustration system={system}/>}
          {preview && save && !current?.visited && <button type="button" disabled={busy} onClick={() => void act(target => gameStorage.append(target, makeEvent('visit', system.id)), `Practice arrival: ${system.name}. No swap or transfer of funds.`)}>Practice arrival in system {system.name}</button>}
          {!preview && !visible?.visited && <p className="callout">This beacon is locked in before requesting a quote. Arrival unlocks only after the server verifies the completed swap. Signing or sending a deposit alone does not confirm arrival.</p>}
          {!preview && !account && <p className="callout">To explore the home system Lada, connect your account and sign in securely to your history. No swap is needed to get started.</p>}
          {otherExpedition && <p className="callout">An expedition is already underway in system {getSystem(otherExpedition.systemId).name}. <button type="button" className="secondary" onClick={() => choose(otherExpedition.systemId)}>Go to active expedition</button></p>}{visible?.visited && <div className="expedition"><h3>Expeditions on {system.planet}</h3><p>Three short chapters. No financial rewards or additional swaps.</p>{current?.next ? <><p><strong>Next chapter: {current.next.title}</strong></p>{current.active && <p>{seconds > 0 ? `Team returns in ${seconds}s.` : 'The team is ready to return. Complete the expedition to unlock the entry.'}{!preview && ' Readiness is confirmed by the server.'}</p>}<button type="button" disabled={busy || !canPlay || Boolean(otherExpedition) || (Boolean(current.active) && seconds > 0) || (!preview && !!save?.queue.length)} onClick={() => void expedition()}>{current.active ? 'Complete expedition and open entry' : 'Start expedition'}</button></> : <p className="complete">All stories in this system are unlocked. Revisit them below.</p>}</div>}
          <ol className="story-list">{system.stories.map((story, index) => <li key={story.id}><h3><span className="story-number">0{index + 1}</span>{' '}{story.title}</h3>{visible?.completed.has(story.id) ? <p>{story.text}</p> : <p className="hint">{index === 0 ? 'Unlocks after the first expedition.' : 'Complete the previous chapter first.'}</p>}</li>)}</ol>
        </section>
        <section className="converter-panel panel" id="converter" aria-labelledby="converter-heading"><p className="eyebrow">04 / Passage</p><h2 id="converter-heading">Converter</h2><p>Destination beacon: <strong>{system.name} · {system.asset}</strong></p><p>Selecting a beacon does not start a swap. Terms, amounts and fees are shown separately from the story.</p>{FinancialPanel ? <FinancialPanel onRecoveryActivated={onRecoveryActivated} activationRecoveryEntries={activationRecoveryEntries} activationRecoveryBlocked={activationRecoveryBlocked} connectRequest={connectRequest} preview={preview} targetAsset={system.asset as Asset} systemId={system.id} onAccountChange={setAccount} onHistorySession={active => { const saved = saveRef.current; if(active && saved?.scope.mode === 'real' && saved.scope.account) void sync(saved.scope); }} onArrival={() => { const active = saveRef.current; if (active?.scope.mode === 'real' && active.scope.account) void sync(active.scope); }}/> : (preview ? <p>Preview: wallets and real swaps are disabled.</p> : <div className="converter-connect"><p>Connect a NEAR wallet to request a quote. The financial module loads only when requested.</p><button type="button" disabled={walletLoading} onClick={()=>void activate()}>{walletLoading?'Loading NEAR wallet…':'Connect NEAR wallet to swap'}</button></div>)}<details className="canon"><summary>How passage threads work</summary><p>{canon}</p></details></section>
      </div>
      <section className="journal-panel panel" id="journal" aria-labelledby="journal-heading"><div className="section-heading"><div><p className="eyebrow">05 / Route memory</p><h2 id="journal-heading">Ship journal</h2></div><span className="sync-label">{preview ? 'Preview only · not synced' : save?.queue.length ? `Not yet synced: ${save.queue.length}` : synced ? 'Confirmed by the server' : 'Local cache · not confirmed by the server'}</span></div><p className="hint">{preview ? 'Practice events are saved separately on this device. They cannot confirm a real arrival.' : 'The cache is separated by NEAR account. Unconfirmed events remain queued; personal ship settings are not sent to the server.'}</p>{!preview && account && <button type="button" className="secondary" disabled={busy} onClick={() => void sync(scope)}>Retry history sync</button>}{save?.events.length ? <ol className="journal-list">{[...save.events].reverse().map(event => <li key={event.eventId}><span>{labels[event.type]} · {getSystem(event.systemId).name}{event.storyId ? ` / ${getSystem(event.systemId).stories.find(story => story.id === event.storyId)?.title}` : ''}</span><span className="hint"><time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString('en-US')}</time> · {preview ? 'practice entry' : save.queue.includes(event.eventId) ? 'not yet synced' : 'confirmed by the server'}</span></li>)}</ol> : <p className="empty">No entries yet. {preview ? 'Start an expedition in Lada or choose a practice arrival in another system.' : 'Sign in securely to start in your home system, or explore the practice world.'}</p>}
        {!preview && account && <div className="data-tools"><button type="button" className="text-button" disabled={busy} aria-expanded={showDeleteJournal} onClick={()=>setShowDeleteJournal(!showDeleteJournal)}>Delete my journal from the server</button>{showDeleteJournal && <div role="group" aria-label="Confirm server journal deletion"><p>Visits and stories will be deleted for account {account}. Blockchain transactions will not be affected. Export your journal first if you want a copy.</p><button type="button" disabled={busy} onClick={()=>void deleteJournal()}>Confirm deletion of server journal</button><button type="button" className="secondary" onClick={()=>setShowDeleteJournal(false)}>Cancel</button></div>}</div>}
        <div className="data-tools"><button type="button" className="secondary" disabled={!save || busy} onClick={() => void download()}>Export save (JSON)</button><label className="file-label" htmlFor="import-save">Import save (JSON, up to 512 KiB)</label><input id="import-save" ref={file} type="file" accept="application/json,.json" disabled={!save || busy} onChange={event => { const picked = event.target.files?.[0]; if (!picked) return; if (picked.size > MAX_EXPORT_BYTES) { setError('This file exceeds 512 KiB. Choose a smaller file.'); event.target.value = ''; return; } void act(async target => gameStorage.import(target, await picked.text()), preview ? 'Practice save imported.' : 'Only ship settings were imported. Live history is restored from the server.'); event.target.value = ''; }}/><button type="button" className="text-button" disabled={!save || busy} aria-expanded={showReset} onClick={() => setShowReset(!showReset)}>Delete local data for this mode</button></div><p className="hint">Import replaces the practice journal only for the same mode and account. In live mode, import changes only the ship and does not confirm arrivals. Secrets and custom images are not accepted.</p>
        {showReset && <div className="reset-confirm"><p>Delete the local ship, cache and queue only for {preview ? 'preview' : account ?? 'guest'}? Unsynced actions will be lost. The server journal will not be deleted.</p><button type="button" disabled={busy} onClick={() => { setShowReset(false); void act(target => gameStorage.clear(target), 'Local data deleted. Server history is unchanged.'); }}>Yes, delete local data</button><button type="button" className="secondary" onClick={() => setShowReset(false)}>Keep data</button></div>}
      </section>
    </main><footer><span>NEARVERSE / Stories at the edge of inhabited space</span><span>Lore and illustrations are built in. There are no monetary rewards.</span></footer>
  </div>;
}
