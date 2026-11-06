// Stage screen (one LED wall, 3328x832) driven from the admin. Pure, shared by the server, the stage page, the panels and the tests.
// ambient: soft rotating moments for when nothing else is happening on stage.
export const SCENES = ['title', 'ambient', 'speaker', 'raffle', 'winner', 'video', 'black'];
export const DEFAULT_STAGE = {
  scene: 'title', speaker: 0, winner: 0, video: '', cueAt: 0, at: 0,
  // Names come from a voice note: placeholders until the client confirms spelling and running order.
  speakers: [
    { name: 'Bin Bin', role: 'Presidente' },
    { name: 'Wilfred', role: 'Director' },
    { name: 'Nacho da Pena', role: 'Vicepresidente' },
  ],
  prizes: [],
};

// WOW cue: a gold sweep crosses panel 1 -> 4 and lands on the stage as the title appears, all off the server clock.
export const PANELS = 4;
export const CUE_LEAD_MS = 6500; // panels poll every 5 s outside raffle mode: every screen must see the cue before it fires
export const CUE_STEP_MS = 450; // delay between neighbouring screens
export const CUE_SWEEP_MS = 900; // one screen's sweep
// Start of the sweep on screen `slot` (1..PANELS for the panels, PANELS + 1 for the stage) relative to cueAt.
export const cueDelay = (slot) => (Math.min(Math.max(1, slot), PANELS + 1) - 1) * CUE_STEP_MS;
// ms into this screen's sweep at local time `now` (negative: not yet). offset = server clock - local clock.
export const cueMs = (now, offset, cueAt, slot) => now + offset - cueAt - cueDelay(slot);
