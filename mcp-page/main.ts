import { NearConnector } from '@hot-labs/near-connect';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status'); const endpoint = `${location.origin}/mcp`;
const AUTH_SCHEME = 'Bearer';
$('endpoint').textContent = endpoint;
let connector: NearConnector | undefined; let current = ''; let busy = false;
// The main site shares this origin's localStorage. Keep the connector's choice in memory and restore
// the wallet's own keys afterwards, so linking an agent never changes the wallet the main site restores.
const memory = new Map<string, string>();
const memoryStorage = { async get(k: string) { return memory.get(k) ?? null; }, async set(k: string, v: string) { memory.set(k, v); }, async remove(k: string) { memory.delete(k); } };
const snapshot = (prefix: string) => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => [k, localStorage.getItem(k)!]));
const restore = (prefix: string, saved: Record<string, string>) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith(prefix) && !(k in saved)) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
};
const say = (text: string) => { status.textContent = text; };
// The status line is a polite live region; it is announced without moving focus.
const announce = (text: string) => { say(text); };
const walletButtons = () => [...document.querySelectorAll<HTMLButtonElement>('#wallets button.secondary')];
const setBusy = (value: boolean) => { busy = value; $('wallets').setAttribute('aria-busy', String(value)); walletButtons().forEach(b => { b.disabled = value; }); };
const withTimeout = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

function readLimits() {
  const perSwapUsd = Number(($('perSwap') as HTMLInputElement).value); const dailyUsd = Number(($('daily') as HTMLInputElement).value);
  const valid = (v: number) => Number.isFinite(v) && v >= 0 && v <= 10000 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
  const bad = !valid(perSwapUsd) ? 'perSwap' : !valid(dailyUsd) || perSwapUsd > dailyUsd ? 'daily' : '';
  for (const id of ['perSwap', 'daily']) $(id).setAttribute('aria-invalid', String(id === bad));
  $('limitsError').textContent = bad ? 'Check the limits: dollars with up to two decimals, at most 10000; the per-swap limit must not exceed the 24-hour limit.' : '';
  if (bad) { $(bad).focus(); return undefined; }
  return { perSwapUsd, dailyUsd };
}

async function signIn(walletId: string) {
  if (busy) return;
  const limits = readLimits();
  if (!limits) return;
  const pressed = document.activeElement as HTMLElement | null;
  const prefix = `${walletId}:`; let saved: Record<string, string> | undefined;
  setBusy(true);
  try {
    saved = snapshot(prefix);
    say('Opening wallet…'); await connector!.connect(walletId);
    const wallet = await connector!.wallet(); const accounts = await wallet.getAccounts(); const accountId = accounts[0]?.accountId;
    if (!accountId) throw new Error('No account was returned by the wallet.');
    say(`Connected as ${accountId}. Requesting the sign-in message…`);
    const cr = await fetch('/mcp/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) });
    const challenge = await cr.json().catch(() => null);
    if (!cr.ok || !challenge?.id) throw new Error(cr.status === 429 ? 'Too many sign-in attempts. Wait one minute and try again.' : cr.status === 400 ? 'This account name is not valid.' : 'The sign-in message could not be created. Try again later.');
    say('Confirm the text message in your wallet. It grants an AI agent access to your journal for 7 days and is not a transaction.');
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: Uint8Array.from(atob(challenge.nonce), c => c.charCodeAt(0)) });
    if (!signed) throw new Error('The wallet did not return a signature.');
    const r = await fetch('/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.id, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, limits }) });
    const data = await r.json();
    if (!r.ok) throw new Error(r.status === 429 ? 'Too many sign-in attempts. Wait one minute and try again.' : `Sign-in was refused (${data.error ?? r.status}).`);
    show(data.token, data.accountId, data.expiresAt, data.limits);
  } catch (e) {
    // Move focus first; a focus change right after an announcement can cut it off in screen readers.
    setBusy(false); pressed?.focus();
    const message = saved ? (e instanceof Error ? e.message : 'Sign-in failed. Try again.') : 'This browser blocks site storage, which wallets need. Allow storage for this site and try again.';
    setTimeout(() => announce(message), 150);
  }
  finally { setBusy(false); if (saved) try { restore(prefix, saved); } catch { /* storage became unavailable */ } }
}

function show(token: string, accountId: string, expiresAt: number, limits: { perSwapUsd: number; dailyUsd: number }) {
  const until = new Date(expiresAt).toUTCString();
  $('limits').textContent = `$${limits.perSwapUsd.toFixed(2)} per swap, $${limits.dailyUsd.toFixed(2)} per 24 hours`;
  current = token; ($('token') as HTMLInputElement).value = token; $('account').textContent = accountId; $('expires').textContent = until;
  ($('config') as HTMLTextAreaElement).value = JSON.stringify({ mcpServers: { nearverse: { type: 'http', url: endpoint, headers: { Authorization: `${AUTH_SCHEME} ${token}` } } } }, null, 2);
  $('result').hidden = false; say(`Agent token created for ${accountId}. It expires ${until}.`); $('step2').focus();
}

async function copy(text: string, label: string) { try { await navigator.clipboard.writeText(text); say(`${label} copied.`); } catch { say('Copy failed. Select the text and copy it manually.'); } }
$('copy').addEventListener('click', () => void copy(current, 'Token'));
$('copyConfig').addEventListener('click', () => void copy(($('config') as HTMLTextAreaElement).value, 'Configuration'));
const revoke = async (all: boolean) => {
  // Revoking is irreversible; ask once so it cannot happen by an accidental key press.
  if (!confirm(all ? 'Revoke every agent token of this account, including lost ones? Agents will lose access immediately.' : 'Revoke this agent token? The agent will lose access immediately.')) return;
  let r: Response;
  try { r = await fetch(all ? '/mcp/api/link?all=1' : '/mcp/api/link', { method: 'DELETE', headers: { Authorization: `${AUTH_SCHEME} ${current}` } }); }
  catch { announce('Network error. The token was not revoked. Try again.'); return; }
  if (r.ok || r.status === 404) {
    current = ''; ($('token') as HTMLInputElement).value = ''; ($('config') as HTMLTextAreaElement).value = ''; $('result').hidden = true;
    // The focused button is now hidden; keep focus on the status line so the result is heard.
    status.focus();
    announce(r.ok ? 'Revoked. Agents can no longer use these tokens.' : 'The token was already revoked or expired.');
  } else announce(r.status === 429 ? 'Too many requests. Wait one minute and try again.' : 'The server could not revoke the token. Try again.');
};
$('revoke').addEventListener('click', () => void revoke(false));
$('revokeAll').addEventListener('click', () => void revoke(true));

// Accessible wallet list instead of a pop-up selector.
$('connect').addEventListener('click', async () => {
  const box = $('wallets'); const button = $('connect') as HTMLButtonElement; button.disabled = true; say('Loading wallets…');
  try {
    connector ??= new NearConnector({ network: 'mainnet', autoConnect: false, storage: memoryStorage, features: { signMessage: true } });
    await withTimeout(connector.whenManifestLoaded, 15000);
    const wallets = connector.availableWallets;
    if (!wallets.length) throw new Error('empty');
    walletButtons().forEach(b => b.remove()); button.hidden = true;
    for (const w of wallets) { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = w.manifest.name; b.addEventListener('click', () => void signIn(w.manifest.id)); box.append(b); }
    say(`${wallets.length} wallets available. Choose one.`); walletButtons()[0]?.focus();
  } catch {
    connector = undefined; button.disabled = false; button.textContent = 'Retry loading wallets';
    say('Wallets could not be loaded. Check your connection and press Retry loading wallets.'); button.focus();
  }
});
