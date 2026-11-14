import type { StarSystem } from './world';
import './system-illustration.css';

// One arrival scene per system; chapter text remains in the story list.
export const systemIllustrations: Record<string, string> = {
  'near-lada': 'A ring of green greenhouses above Willow’s ocean in the light of dawn.',
  'near-echo': 'A radio telescope with an open dish among Measure’s icy ridges.',
  'btc-basalt': 'Core’s stone archive: rows of pale tablets and a passage deep into the rock.',
  'btc-ember': 'A train-city on rails travels along a narrow band of warm light on Trench.',
  'eth-weft': 'Braid’s illuminated bridge spans reach from opposite banks toward a gap above the water.',
  'eth-prism': 'Facet’s angular crystalline clouds split a slanting beam into bands of light.',
  'usdt-harbor': 'Tal’s repair harbor: a ship at its berth and a view of the planet through a wide airlock.',
  'usdt-linen': 'Flax’s tall white antennas open like sails above a quiet horizon.',
  'usdc-balance': 'A warehouse on Bowl: one shelf is left empty between rows of containers.',
  'sol-pulse': 'Two cities on the slopes of a valley on Spark exchange gentle beacon light.',
};

interface SystemIllustrationProps { system: StarSystem }

export function SystemIllustration({ system }: SystemIllustrationProps) {
  const alt = systemIllustrations[system.id];
  if (!alt) return null;
  return <figure className="system-illustration" data-system-id={system.id}>
    <img key={system.id} src={`${import.meta.env.BASE_URL}art/systems/${system.id}.svg`} alt={alt} width={960} height={540} loading="lazy" decoding="async"/>
    <figcaption><span className="system-illustration-label">Atlas view</span><span>{system.name} / {system.planet}</span></figcaption>
  </figure>;
}
