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
async function guest() {
  render(<App/>);
  await screen.findByRole('button', { name: 'Edit ship' });
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
    expect(screen.queryByRole('button', { name: 'Isolated preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start expedition' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Practice arrival/ })).toBeNull();
    expect(screen.queryByText('SDK: real disabled / NEAR / near-lada')).toBeNull();
    expect((screen.getByRole('button', {name:'Connect NEAR wallet'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/No wallet connected\./)).toBeTruthy();
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
  it('has no practice mode and shows nothing about a system or its chapters before a verified swap', async () => {
    await guest();
    const map = screen.getByRole('region', { name: 'Atlas of passage threads' });
    expect(within(map).getAllByRole('button').every(b => /Closed$/.test(b.textContent ?? ''))).toBe(true);
    expect(screen.getByText(/This system is closed\. Swap any amount into NEAR/)).toBeTruthy();
    expect(screen.queryByText(/A ring of greenhouses/)).toBeNull();
    expect(screen.queryByText(/Botanist Ruta/)).toBeNull();
    fireEvent.click(within(map).getByRole('button', { name: /Basalt/ }));
    expect(document.activeElement?.id).toBe('system-heading');
    expect(screen.getByText(/This system is closed\. Swap any amount into BTC/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Practice arrival/ })).toBeNull();
  });
  it('renders imported biography as inert text and preserves ship settings after remount', async () => {
    await guest();
    fireEvent.click(screen.getByRole('button', { name: 'Edit ship' }));
    fireEvent.change(screen.getByLabelText('Ship name'), { target: { value: 'Медленный свет' } });
    fireEvent.change(screen.getByLabelText('Biography'), { target: { value: '<img src=x onerror=alert(1)> Текст, не HTML.' } });
    fireEvent.change(screen.getByLabelText('Built-in design'), { target: { value: 'sail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ship' }));
    await screen.findByRole('heading', { name: 'Медленный свет' });
    expect(document.querySelector('.biography img')).toBeNull();
    expect(document.querySelector('.biography')?.textContent).toBe('<img src=x onerror=alert(1)> Текст, не HTML.');
    expect(document.querySelector('img[onerror]')).toBeNull();
    cleanup(); await guest();
    expect(screen.getByRole('heading', { name: 'Медленный свет' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Built-in ship illustration: solar sail' })).toBeTruthy();
  });
  it('reports unsigned account history as unsynced rather than unlocking exploration', async () => {
    render(<App/>);
    await screen.findByRole('button', { name: 'Edit ship' });
    fireEvent.click(screen.getByRole('button', {name:'Connect NEAR wallet'}));
    await screen.findByRole('region', {name:'SDK fixture'});
    fireEvent.click(screen.getByRole('button', { name: 'Fixture account (no wallet)' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('separate sign-in');
    expect(screen.queryByRole('button', { name: 'Start expedition' })).toBeNull();
    expect(screen.getByText('Local cache · not confirmed by the server')).toBeTruthy();
  });
  it('rejects an import from another account and keeps current progress untouched', async () => {
    await guest();
    const raw = JSON.stringify(emptySave({ mode: 'real', account: 'alice.near' }));
    const file = new File([raw], 'save.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => raw });
    await act(async () => { fireEvent.change(screen.getByLabelText('Import save (JSON, up to 512 KiB)'), { target: { files: [file] } }); });
    expect((await screen.findByRole('alert')).textContent).toContain('different account or mode');
    expect((await gameStorage.load({ mode: 'real', account: null })).events).toEqual([]);
  });
});
