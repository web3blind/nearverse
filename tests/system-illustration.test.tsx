// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemIllustration, systemIllustrations } from '../src/SystemIllustration';
import { systems } from '../src/world';

afterEach(cleanup);

describe('accessible arrival artwork', () => {
  it('has an illustration for every reachable system and no orphaned mapping', () => {
    expect(Object.keys(systemIllustrations).sort()).toEqual(systems.map(system => system.id).sort());
  });

  it.each(systems)('renders the matching static scene for $id', system => {
    render(<SystemIllustration system={system}/>);
    const image = screen.getByRole('img');
    expect(image.getAttribute('alt')?.trim().length).toBeGreaterThan(24);
    expect(image.getAttribute('src')).toBe(`/art/systems/${system.id}.svg`);
    expect(image.getAttribute('width')).toBe('960');
    expect(image.getAttribute('height')).toBe('540');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.closest('figure')?.dataset.systemId).toBe(system.id);
    expect(screen.getByText(`${system.name} / ${system.planet}`)).toBeTruthy();

    const svg = readFileSync(resolve('public/art/systems', `${system.id}.svg`), 'utf8');
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.localName).toBe('svg');
    expect(document.querySelector('script, foreignObject, animate, animateTransform, animateMotion')).toBeNull();
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.toLowerCase().startsWith('on')).toBe(false);
        if (attribute.localName === 'href') expect(attribute.value.startsWith('#')).toBe(true);
      }
    }
  });
});
