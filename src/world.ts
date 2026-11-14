import type { Asset } from './assets';
export type { Asset } from './assets';
export interface Story { id: string; title: string; text: string; durationSeconds: number }
export interface StarSystem { id: string; asset: Asset; name: string; subtitle: string; planet: string; description: string; x: number; y: number; stories: Story[] }
export interface Region { asset: Asset; name: string; material: string; description: string }
export const WORLD_VERSION = 1;
export const regions: Region[] = [
  { asset: 'NEAR', name: 'Near Arm', material: 'neutral plasma', description: 'Gardeners’ beacons and inhabited orbital stations.' },
  { asset: 'BTC', name: 'Stone Frontier', material: 'dense crystalline reserves', description: 'Ancient repositories, slow-burning stars and enduring memory.' },
  { asset: 'ETH', name: 'Weaver’s Nebula', material: 'plasma energy', description: 'A world of builders weaving orbits into shared patterns.' },
  { asset: 'USDT', name: 'Quiet Harbor', material: 'stabilized mixture', description: 'Waystations, archives and berths for long voyages.' },
  { asset: 'USDC', name: 'Equilibrium', material: 'stable energy', description: 'Beacons of shared reserves and quiet agreements.' },
  { asset: 'SOL', name: 'Pulse Arm', material: 'pulsed energy', description: 'Brief signals connect distant settlements.' },
];
function stories(prefix: string, entries: [string, string][]): Story[] {
  return entries.map(([title, text], index) => ({ id: `${prefix}-${index + 1}`, title, text, durationSeconds: 15 }));
}
export const systems: StarSystem[] = [
  { id: 'near-lada', asset: 'NEAR', name: 'Lada', subtitle: 'A Garden on the Sunlit Side', planet: 'Willow', x: 19, y: 27,
    description: 'A ring of greenhouses hangs above Willow’s ocean. Your journey begins here.', stories: stories('lada', [
      ['A Letter in a Seed', 'Botanist Ruta meets you in the greenhouse airlock. She hands you a seed with a tiny coil inside: the garden preserves the voices of the first settlers. One of the voices asks you to find a lost beacon.'],
      ['A Shadow Beneath the Ring', 'Searching for the beacon, you descend to the maintenance deck beneath the greenhouse. Every morning, its mirrors direct light onto an empty stretch of ocean. Ruta says there was once an island there, no longer marked on any map.'],
      ['The Right to a Dawn', 'You search the stretch of ocean lit by the mirrors and find an old buoy. Its beacon still marks the morning above the sunken island. “Let it shine,” Ruta says. You record the buoy in your log.'],
    ]) },
  { id: 'near-echo', asset: 'NEAR', name: 'Echo', subtitle: 'The Station That Listens', planet: 'Measure', x: 36, y: 15,
    description: 'Radio telescopes on icy Measure receive signals from ships long gone.', stories: stories('echo', [
      ['Someone Else’s Greeting', 'A minute before your transmission, duty officer Saya picks up a greeting addressed to your ship. She checks the recording against the archive: the station is repeating an old call sign from a ship with the same name.'],
      ['An Archive of Silence', 'The old call sign leads you to the earlier ship’s recordings in the archive. Its crew shut down the engines to hear a faint signal beyond the nebula. The final recording consists of forty seconds of silence.'],
      ['An Answer Without Words', 'Saya amplifies the final archive recording. A faint sound emerges from the forty seconds of silence. “It sounds like Measure’s ocean,” she says. You note this in your log as a possibility: the source of the signal is still unknown.'],
    ]) },
  { id: 'btc-basalt', asset: 'BTC', name: 'Basalt', subtitle: 'Memory Deep in Stone', planet: 'Core', x: 69, y: 19,
    description: 'On Core, archives are built to last a million winters.', stories: stories('basalt', [
      ['The Weight of a Word', 'Archivist Teren asks you to take a palm-sized tablet to the translation room. It bears a single word in the language of a vanished city. Its meaning is unknown. You take the tablet and go to compare the word with the archive copies.'],
      ['The Translation Room', 'In the stone chamber, you compare the tablet with thousands like it. Each generation has offered its own translation. “Home,” “duty,” “farewell” — none has been crossed out. The catalog contains no evidence confirming any of them.'],
      ['Leaving the Question Open', 'You return the tablet to Teren: the catalog has not helped you settle on a translation. Beside the earlier suggestions, he leaves a blank line for your answer. You write: “Meaning unknown.”'],
    ]) },
  { id: 'btc-ember', asset: 'BTC', name: 'Ember', subtitle: 'The Warmth of a Slow-Burning Star', planet: 'Trench', x: 84, y: 39,
    description: 'Cities on rails follow a narrow band of warmth.', stories: stories('ember', [
      ['A Requested Stop', 'The train-city stops at an empty platform. Driver Nori is waiting for a passenger whose ticket was bought a hundred years ago. The ticket has not expired.'],
      ['A Garden Behind Glass', 'You find an automated garden beside the platform. Nori says he is waiting for its only gardener. But it is a container holding a tree that rolls slowly toward the train; you do not know who sent it.'],
      ['A Seat by the Window', 'You help place the container with the tree by a window. Nori punches the old ticket, and the train sets off. The platform and its automated garden fall behind.'],
    ]) },
  { id: 'eth-weft', asset: 'ETH', name: 'Weft', subtitle: 'The Architecture of a Shared Sky', planet: 'Braid', x: 28, y: 68,
    description: 'Above Braid hang bridges held together by agreements rather than supports.', stories: stories('weft', [
      ['The Missing Support', 'Engineer Yara shows you a bridge with a missing section. No one crosses it, but its lights come on every evening. The other bank answers in kind.'],
      ['Two Designs', 'You carry drawings between the banks. The authors of one design want to leave the span open for river birds; the others want room for large ships. Yara lays the plans side by side: both claim the space of the missing section, and there is no shared solution yet.'],
      ['A Bridge with a Pause', 'After comparing the drawings, the architects design a lifting section. Raised, it leaves the span clear for birds and vessels; lowered, it lets people cross. Yara checks the crossing schedule: each time, someone will have to wait.'],
    ]) },
  { id: 'eth-prism', asset: 'ETH', name: 'Prism', subtitle: 'Light Turned into Letters', planet: 'Facet', x: 46, y: 84,
    description: 'Facet’s crystalline clouds refract messages between settlements.', stories: stories('prism', [
      ['The Wrong Color', 'Keeper Eli discovers an unfamiliar shade in a letter made of light. All the instruments are working. The color appears only at sunset.'],
      ['A Cloud as Witness', 'At sunset, you rise above the clouds and trace the beam to an abandoned house. It passes through old colored glass before continuing toward the clouds. The unfamiliar shade appears after the glass.'],
      ['The Weather’s Handwriting', 'You show Eli where the beam changes color. She marks the house on the map and records the shade beside the words “I remember.” For now, it is her own annotation: she does not add it to the alphabet used for letters.'],
    ]) },
  { id: 'usdt-harbor', asset: 'USDT', name: 'Harbor', subtitle: 'A Place Between Voyages', planet: 'Tal', x: 72, y: 66,
    description: 'In Tal’s harbor, ships are repaired and travelers are given time.', stories: stories('harbor', [
      ['An Open Airlock', 'Dispatcher Ort offers you an unnumbered berth. It is kept for ships that do not know their next destination. Here, you are allowed simply to stop.'],
      ['A Map Without an Arrow', 'In the workshop, you find a map marked with resting places. It shows no shortest route. Each captain has added something that helped them continue their journey.'],
      ['Your Own Mark', 'You mark a quiet gallery overlooking Tal. Ort hangs the map by the shared airlock. Now a captain you have never met will be able to find a place you once needed.'],
    ]) },
  { id: 'usdt-linen', asset: 'USDT', name: 'Sail', subtitle: 'The Observatory of Returns', planet: 'Flax', x: 86, y: 83,
    description: 'Flax’s white antennas recognize ships by the sound of their engines.', stories: stories('linen', [
      ['A Familiar Sound', 'Operator Fara hears something familiar in your engine noise, though this is your first visit. She finds a similar recording in the catalog of repaired components and suggests checking the part.'],
      ['A Part from Far Away', 'You find a barely visible notch on the part. Fara shows you the catalog entry: the part was repaired on Flax, and the mechanic labeled the notch “a promise to return.” The sound has led you to the right component.'],
      ['The Part Returns', '“The part has returned. The crew is different,” Fara writes beside the mechanic’s promise. Before leaving, you add a new notch beside the old one. Fara records it in the catalog.'],
    ]) },
  { id: 'usdc-balance', asset: 'USDC', name: 'Measure', subtitle: 'Supplies for a Stranger', planet: 'Bowl', x: 52, y: 47,
    description: 'On Bowl, every warehouse leaves one shelf empty.', stories: stories('balance', [
      ['The Empty Shelf', 'Keeper Lev shows you a shelf with no cargo. Space is set aside here for supplies for a future guest whose name is not yet known. “We have the shelf,” Lev says, “but we still need to gather the supplies.”'],
      ['The Weight of a Promise', 'Two ships arrive today. The available supplies are enough for only one usual allotment. You help the crews record the needs of both voyages and divide the cargo they have. Supplies missing from the warehouse remain on the list.'],
      ['A Shared Table', 'Around a shared table, the crews discuss a joint departure, but there are still not enough supplies. The shelf is empty; so are the two new containers beside it. Lev records how much more they need to gather. The departure remains an open question.'],
    ]) },
  { id: 'sol-pulse', asset: 'SOL', name: 'Pulse', subtitle: 'A Minute of Shared Light', planet: 'Spark', x: 12, y: 52,
    description: 'Spark’s cities greet one another with brief flashes of light.', stories: stories('pulse', [
      ['The Missing Flash', 'Signal operator Nika notices that a distant city has stopped answering. Its beacon is working. You agree to deliver a simple message: they are waiting for a reply here.'],
      ['Time to Listen', 'In the distant city, people are welcoming the first rain after a long drought. You deliver the message at the beacon. “We are here. We will answer this evening,” they tell you. Back with Nika, you repeat their words and ask her not to send another signal yet.'],
      ['A Different Rhythm', 'That evening, the distant city answers with a long, gentle flash. Nika notes the time of the reply and leaves a longer pause in the schedule. She waits by the receiver until the next signal.'],
    ]) },
];
export function getSystem(id: string): StarSystem {
  const system = systems.find(item => item.id === id);
  if (!system) throw new Error('Unknown system');
  return system;
}
export function validateWorld(): void {
  const ids = new Set<string>();
  for (const system of systems) {
    if (ids.has(system.id) || !regions.some(region => region.asset === system.asset)) throw new Error('Invalid world canon');
    ids.add(system.id);
    for (const story of system.stories) {
      if (ids.has(story.id) || !story.text || story.durationSeconds < 0) throw new Error('Invalid story');
      ids.add(story.id);
    }
  }
}
validateWorld();
export const canon = 'Energy is the everyday name for the ship’s working material. The converter changes its state, while a beacon lays a transit thread. This is a fictional convention of NearVerse, not a description of physics. A jump does not consume your entire reserve: actual amounts, fees and the asset you receive are determined separately in the converter. Exploration requires no additional swaps and offers no monetary rewards.';
