// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { gameStorage, emptySave, type GameSave } from '../src/storage';

vi.mock('../src/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/storage')>();
  const values = new Map<string, GameSave>();
  return { ...actual, gameStorage: actual.createGameStorage({ async get(key) { return structuredClone(values.get(key)); }, async set(key, value) { values.set(key, structuredClone(value)); } }) };
});
vi.mock('../src/sdk/FinancialPanel', () => ({ FinancialPanel: (props: { preview: boolean; targetAsset: string; systemId: string; onAccountChange: (account: string | null) => void }) => <section aria-label="SDK fixture"><p>SDK: {props.preview ? 'preview disabled' : 'real disabled'} / {props.targetAsset} / {props.systemId}</p><button onClick={() => props.onAccountChange('alice.near')}>Fixture account (no wallet)</button></section> }));

beforeEach(async () => {
  await gameStorage.clear({ mode: 'preview', account: null });
  await gameStorage.clear({ mode: 'real', account: null });
  await gameStorage.clear({ mode: 'real', account: 'alice.near' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function preview() {
  render(<App/>);
  await screen.findByRole('button', { name: 'Edit ship' });
  fireEvent.click(screen.getByRole('button', {name:'Connect NEAR wallet'}));
  await screen.findByRole('region', {name:'SDK fixture'});
  fireEvent.click(screen.getByRole('button', { name: 'Isolated preview' }));
  await screen.findByText('Practice progress is stored on this device.');
}
describe('English accessible game UI', () => {
  it('starts in real fail-closed mode, exposes landmarks and all equivalent map controls', async () => {
    render(<App/>);
    await screen.findByRole('button', { name: 'Edit ship' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe('#main');
    const map = screen.getByRole('region', { name: 'Atlas of passage threads' });
    expect(within(map).getAllByRole('button')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: 'Start expedition' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Practice arrival/ })).toBeNull();
    expect(screen.queryByText('SDK: real disabled / NEAR / near-lada')).toBeNull();
    expect((screen.getByRole('button', {name:'Connect NEAR wallet'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Live mode\. No wallet connected\./)).toBeTruthy();
    expect(screen.queryByText(/Explore the world safely in isolated preview mode/)).toBeNull();
  });
  it('offers a converter-local wallet control that opens the same financial module', async () => {
    render(<App/>);
    await screen.findByRole('button', { name: 'Edit ship' });
    const converter = screen.getByRole('region', { name: 'Converter' });
    fireEvent.click(within(converter).getByRole('button', { name: 'Connect NEAR wallet to swap' }));
    await screen.findByRole('region', { name: 'SDK fixture' });
    expect(within(converter).queryByRole('button', { name: 'Connect NEAR wallet to swap' })).toBeNull();
  });
  it('keeps the real SDK panel mounted but disabled in explicitly isolated preview', async () => {
    await preview();
    expect(screen.getByText('PREVIEW · Practice space')).toBeTruthy();
    expect(screen.getByText('SDK: preview disabled / NEAR / near-lada')).toBeTruthy();
    expect(screen.getByText('Preview only · not synced')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('binds the chosen beacon before quote and moves focus to its heading', async () => {
    await preview();
    fireEvent.click(screen.getByRole('button', { name: /Basalt Memory Deep in Stone/ }));
    expect(screen.getByText('SDK: preview disabled / BTC / btc-basalt')).toBeTruthy();
    expect(document.activeElement?.id).toBe('system-heading');
    fireEvent.click(screen.getByRole('button', { name: 'Practice arrival in system Basalt' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start expedition' }) as HTMLButtonElement).disabled).toBe(false));
    expect((await gameStorage.load({ mode: 'preview', account: null })).events[0].type).toBe('visit');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists a started expedition, completes sequential story and restores it on remount', async () => {
    await preview();
    fireEvent.click(screen.getByRole('button', { name: 'Start expedition' }));
    await screen.findByText(/Practice expedition started/);
    expect((screen.getByRole('button', { name: 'Complete expedition and open entry' }) as HTMLButtonElement).disabled).toBe(true);
    const old = Date.now(); const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(old + 16000);
    // Remount exercises reconstruction from the saved start timestamp without waiting on a real timer.
    cleanup(); await preview();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Complete expedition and open entry' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Complete expedition and open entry' }));
    await screen.findByText(/Botanist Ruta meets you in the greenhouse airlock/);
    expect(screen.getByText('Next chapter: A Shadow Beneath the Ring')).toBeTruthy();
    const saved = await gameStorage.load({ mode: 'preview', account: null });
    expect(saved.events.map(event => event.type)).toEqual(['expedition.started', 'expedition.completed', 'story.read']);
    expect(saved.queue).toEqual([]);
    dateSpy.mockRestore();
  });
  it('renders imported biography as inert text and preserves ship settings after remount', async () => {
    await preview();
    fireEvent.click(screen.getByRole('button', { name: 'Edit ship' }));
    fireEvent.change(screen.getByLabelText('Ship name'), { target: { value: 'Медленный свет' } });
    fireEvent.change(screen.getByLabelText('Biography'), { target: { value: '<img src=x onerror=alert(1)> Текст, не HTML.' } });
    fireEvent.change(screen.getByLabelText('Built-in design'), { target: { value: 'sail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ship' }));
    await screen.findByRole('heading', { name: 'Медленный свет' });
    expect(document.querySelector('.biography img')).toBeNull();
    expect(document.querySelector('.biography')?.textContent).toBe('<img src=x onerror=alert(1)> Текст, не HTML.');
    expect(document.querySelector('img[onerror]')).toBeNull();
    cleanup(); await preview();
    expect(screen.getByRole('heading', { name: 'Медленный свет' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Built-in ship illustration: solar sail' })).toBeTruthy();
  });
  it('does not carry preview arrivals or personal ship data into the real cache', async () => {
    await preview();
    fireEvent.click(screen.getByRole('button', { name: /Basalt Memory/ }));
    fireEvent.click(screen.getByRole('button', { name: /Practice arrival in system Basalt/ }));
    await screen.findByText(/Practice arrival: Basalt/);
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    await screen.findByText(/No wallet connected/);
    expect((await gameStorage.load({ mode: 'real', account: null })).events).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Start expedition' })).toBeNull();
    expect(screen.getByText('SDK: real disabled / BTC / btc-basalt')).toBeTruthy();
  });
  it('reports unsigned account history as unsynced rather than unlocking exploration', async () => {
    render(<App/>);
    await screen.findByRole('button', { name: 'Edit ship' });
    fireEvent.click(screen.getByRole('button', {name:'Connect NEAR wallet'}));
    await screen.findByRole('region', {name:'SDK fixture'});
    fireEvent.click(screen.getByRole('button', { name: 'Fixture account (no wallet)' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('separate sign-in');
    expect((screen.getByRole('button', { name: 'Start expedition' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Local cache · not confirmed by the server')).toBeTruthy();
  });
  it('rejects a cross-mode import and keeps current preview progress untouched', async () => {
    await preview();
    const raw = JSON.stringify(emptySave({ mode: 'real', account: 'alice.near' }));
    const file = new File([raw], 'save.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => raw });
    await act(async () => { fireEvent.change(screen.getByLabelText('Import save (JSON, up to 512 KiB)'), { target: { files: [file] } }); });
    expect((await screen.findByRole('alert')).textContent).toContain('different account or mode');
    expect((await gameStorage.load({ mode: 'preview', account: null })).events).toEqual([]);
  });
});
