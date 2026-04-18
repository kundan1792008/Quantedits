/**
 * MelodyGenerator — Markov-chain driven multi-track music composer
 *
 * Generates a four-track MIDI-style sequence (melody, bass, chords/pad,
 * percussion) tailored to a requested genre, tempo and intensity curve.
 *
 * Architecture
 * ────────────
 *   1. Music Theory Layer
 *        Provides scales, chord templates, voice-leading helpers and
 *        deterministic random utilities so a given seed always yields the
 *        same composition (important for "re-generate vs. re-render").
 *
 *   2. Markov Layer
 *        Genre-specific note-transition tables (1st-order interval Markov
 *        chains) and rhythm-transition tables. Tables are normalised on
 *        construction and lookups are O(log n) via cumulative arrays.
 *
 *   3. Composer Layer
 *        Orchestrates the layers above. Walks a "music blueprint"
 *        (mood/intensity timeline, optionally produced by a video analyser)
 *        and emits structured `Composition` objects that the
 *        AudioSynthesizer can render to PCM audio.
 *
 * The output is intentionally library-free MIDI-ish data: numbers + strings
 * only, so the generator is testable without any audio context.
 */

// ── Public types ───────────────────────────────────────────────────────────

/** Supported musical genres. */
export type Genre =
  | "lofi"
  | "cinematic"
  | "pop"
  | "ambient"
  | "electronic"
  | "classical";

/** Mood label used by the music blueprint. */
export type Mood = "happy" | "dramatic" | "chill" | "epic" | "melancholic" | "tense";

/** Pacing label used by the music blueprint. */
export type Pacing = "fast" | "medium" | "slow";

/** Logical instrument tracks emitted by the generator. */
export type InstrumentTrack = "melody" | "bass" | "chords" | "percussion";

/** Wave-shape hint for the synthesizer. */
export type Timbre = "sine" | "triangle" | "sawtooth" | "square" | "pulse" | "noise" | "wavetable";

/**
 * A single timed musical event.
 *
 * `pitch` follows MIDI semantics: 60 = middle C, 69 = A4 (440 Hz). For
 * percussion events `pitch` encodes a General-MIDI-like drum slot
 * (35 = kick, 38 = snare, 42 = closed hi-hat …) and `timbre` is `noise`.
 */
export interface NoteEvent {
  /** Track this event belongs to. */
  track: InstrumentTrack;
  /** MIDI pitch number (0–127). */
  pitch: number;
  /** Velocity (0–1, linear). */
  velocity: number;
  /** Start time in seconds, relative to the composition start. */
  startSec: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Wave-shape hint for the synthesizer. */
  timbre: Timbre;
  /** Articulation (legato, staccato, accent…) — optional advisory flag. */
  articulation?: "legato" | "staccato" | "accent" | "tenuto";
}

/** A diatonic key, e.g. `{ tonic: 60, scale: "minor" }` for C minor. */
export interface MusicalKey {
  /** MIDI pitch class of the tonic, 0–11 (0 = C). */
  tonic: number;
  /** Scale flavour. */
  scale: ScaleName;
}

/** Supported scale names. */
export type ScaleName =
  | "major"
  | "minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "minorPentatonic"
  | "majorPentatonic"
  | "blues"
  | "harmonicMinor"
  | "wholeTone"
  | "chromatic";

/**
 * One marker on the music blueprint timeline. Several markers chain
 * together to describe how the soundtrack should evolve over time.
 */
export interface BlueprintMarker {
  /** Start time of this region (seconds). */
  startSec: number;
  /** End time of this region (seconds). */
  endSec: number;
  /** Mood for this region. */
  mood: Mood;
  /** Pacing for this region. */
  pacing: Pacing;
  /** Intensity in [0, 1]. */
  intensity: number;
}

/** Full music blueprint produced by an analyser (or hand-crafted). */
export interface MusicBlueprint {
  /** Total duration in seconds. */
  durationSec: number;
  /** Markers ordered by `startSec`. */
  markers: BlueprintMarker[];
}

/** Options for `MelodyGenerator.generate`. */
export interface GenerateOptions {
  /** Genre to compose in. */
  genre: Genre;
  /** Optional tempo override in BPM (otherwise derived from genre/blueprint). */
  bpmOverride?: number;
  /** Master intensity multiplier (0–1). */
  intensity?: number;
  /** Random seed; same seed → same composition. */
  seed?: number;
  /** Music blueprint that shapes the timeline. */
  blueprint: MusicBlueprint;
}

/** A finished composition ready for synthesis. */
export interface Composition {
  /** Genre actually used. */
  genre: Genre;
  /** Final tempo in BPM. */
  bpm: number;
  /** Time signature numerator (e.g. 4 for 4/4). */
  beatsPerBar: number;
  /** Final musical key. */
  key: MusicalKey;
  /** All note events, sorted by `startSec`. */
  events: NoteEvent[];
  /** Total duration in seconds (>= last event end). */
  durationSec: number;
  /** Per-track summary statistics. */
  trackStats: Record<InstrumentTrack, TrackStats>;
  /** Random seed actually used. */
  seed: number;
}

export interface TrackStats {
  /** Number of events on this track. */
  noteCount: number;
  /** Mean pitch (midi). */
  averagePitch: number;
  /** Lowest pitch present. */
  minPitch: number;
  /** Highest pitch present. */
  maxPitch: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Standard A-440 reference. */
export const A4_FREQUENCY = 440;
/** MIDI pitch number of A4. */
export const A4_MIDI = 69;
/** Smallest representable note duration (32nd note triplet) in beats. */
export const TICK_PER_BEAT = 24;

const PITCH_CLASS_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  major:           [0, 2, 4, 5, 7, 9, 11],
  minor:           [0, 2, 3, 5, 7, 8, 10],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  phrygian:        [0, 1, 3, 5, 7, 8, 10],
  lydian:          [0, 2, 4, 6, 7, 9, 11],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  blues:           [0, 3, 5, 6, 7, 10],
  harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
  wholeTone:       [0, 2, 4, 6, 8, 10],
  chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Diatonic chord qualities by scale degree (1-indexed) for major scale. */
const MAJOR_DIATONIC_QUALITIES = [
  "maj", "min", "min", "maj", "maj", "min", "dim",
] as const;

/** Diatonic chord qualities for natural minor. */
const MINOR_DIATONIC_QUALITIES = [
  "min", "dim", "maj", "min", "min", "maj", "maj",
] as const;

/** Chord interval templates (semitones above the root). */
const CHORD_INTERVALS: Record<string, number[]> = {
  maj:    [0, 4, 7],
  min:    [0, 3, 7],
  dim:    [0, 3, 6],
  aug:    [0, 4, 8],
  sus2:   [0, 2, 7],
  sus4:   [0, 5, 7],
  maj7:   [0, 4, 7, 11],
  min7:   [0, 3, 7, 10],
  dom7:   [0, 4, 7, 10],
  min9:   [0, 3, 7, 10, 14],
  add9:   [0, 4, 7, 14],
  m7b5:   [0, 3, 6, 10],
};

// ── Genre profiles ─────────────────────────────────────────────────────────

interface GenreProfile {
  /** Default BPM. */
  defaultBpm: number;
  /** BPM range used to react to pacing markers. */
  bpmRange: { min: number; max: number };
  /** Preferred scale for "happy" / bright moods. */
  brightScale: ScaleName;
  /** Preferred scale for "dramatic" / dark moods. */
  darkScale: ScaleName;
  /** Tonic pitch class biases (0–11). Picked deterministically from seed. */
  preferredTonics: number[];
  /** Melody octave centre (MIDI). */
  melodyCentre: number;
  /** Bass octave centre. */
  bassCentre: number;
  /** Chord octave centre. */
  chordCentre: number;
  /** Timbre selections per track. */
  timbres: Record<InstrumentTrack, Timbre>;
  /** Probability of any given 16th-note slot containing a note (melody). */
  melodyDensity: number;
  /** Probability of bass attack on each beat. */
  bassDensity: number;
  /** Beats per chord change (e.g. 4 = one chord per bar in 4/4). */
  chordRateBeats: number;
  /** Drum kit pattern key (see `DRUM_PATTERNS`). */
  drumPattern: keyof typeof DRUM_PATTERNS;
  /** Swing factor 0–0.5 (offsets the off-beat 16ths). */
  swing: number;
  /** Dynamic range 0–1 (small = compressed, large = expressive). */
  dynamics: number;
}

const GENRE_PROFILES: Record<Genre, GenreProfile> = {
  lofi: {
    defaultBpm: 78,
    bpmRange: { min: 65, max: 92 },
    brightScale: "majorPentatonic",
    darkScale: "minorPentatonic",
    preferredTonics: [0, 2, 5, 7, 9],
    melodyCentre: 72,
    bassCentre: 36,
    chordCentre: 60,
    timbres: { melody: "triangle", bass: "sine", chords: "sine", percussion: "noise" },
    melodyDensity: 0.45,
    bassDensity: 0.65,
    chordRateBeats: 4,
    drumPattern: "lofi",
    swing: 0.16,
    dynamics: 0.35,
  },
  cinematic: {
    defaultBpm: 96,
    bpmRange: { min: 60, max: 130 },
    brightScale: "lydian",
    darkScale: "harmonicMinor",
    preferredTonics: [0, 2, 5, 7, 9, 10],
    melodyCentre: 74,
    bassCentre: 33,
    chordCentre: 57,
    timbres: { melody: "sawtooth", bass: "triangle", chords: "wavetable", percussion: "noise" },
    melodyDensity: 0.4,
    bassDensity: 0.55,
    chordRateBeats: 4,
    drumPattern: "cinematic",
    swing: 0.0,
    dynamics: 0.85,
  },
  pop: {
    defaultBpm: 116,
    bpmRange: { min: 90, max: 138 },
    brightScale: "major",
    darkScale: "minor",
    preferredTonics: [0, 2, 4, 5, 7, 9, 11],
    melodyCentre: 72,
    bassCentre: 36,
    chordCentre: 60,
    timbres: { melody: "sawtooth", bass: "square", chords: "triangle", percussion: "noise" },
    melodyDensity: 0.5,
    bassDensity: 0.7,
    chordRateBeats: 2,
    drumPattern: "pop",
    swing: 0.04,
    dynamics: 0.6,
  },
  ambient: {
    defaultBpm: 60,
    bpmRange: { min: 40, max: 80 },
    brightScale: "lydian",
    darkScale: "dorian",
    preferredTonics: [0, 2, 4, 7, 9],
    melodyCentre: 76,
    bassCentre: 36,
    chordCentre: 60,
    timbres: { melody: "sine", bass: "sine", chords: "wavetable", percussion: "noise" },
    melodyDensity: 0.18,
    bassDensity: 0.25,
    chordRateBeats: 8,
    drumPattern: "ambient",
    swing: 0.0,
    dynamics: 0.5,
  },
  electronic: {
    defaultBpm: 124,
    bpmRange: { min: 100, max: 150 },
    brightScale: "minor",
    darkScale: "phrygian",
    preferredTonics: [0, 2, 5, 7, 9],
    melodyCentre: 72,
    bassCentre: 36,
    chordCentre: 60,
    timbres: { melody: "pulse", bass: "sawtooth", chords: "sawtooth", percussion: "noise" },
    melodyDensity: 0.55,
    bassDensity: 0.85,
    chordRateBeats: 4,
    drumPattern: "electronic",
    swing: 0.0,
    dynamics: 0.4,
  },
  classical: {
    defaultBpm: 92,
    bpmRange: { min: 50, max: 140 },
    brightScale: "major",
    darkScale: "harmonicMinor",
    preferredTonics: [0, 2, 4, 5, 7, 9, 11],
    melodyCentre: 74,
    bassCentre: 38,
    chordCentre: 60,
    timbres: { melody: "triangle", bass: "triangle", chords: "wavetable", percussion: "noise" },
    melodyDensity: 0.55,
    bassDensity: 0.45,
    chordRateBeats: 4,
    drumPattern: "classical",
    swing: 0.0,
    dynamics: 0.9,
  },
};

// ── Markov interval tables (per genre) ─────────────────────────────────────

/**
 * Rows: previous interval expressed as an integer in [-7, 7] (semitones,
 * clipped). Columns: same range. Values are unnormalised weights and are
 * normalised on construction. Chosen by hand to evoke each genre's feel
 * (small leaps for lofi/ambient, larger leaps for cinematic, etc.).
 */
type IntervalMatrix = number[][];

const INTERVAL_RANGE = 7; // -7..+7 → 15 columns

function uniformRow(): number[] {
  return new Array(INTERVAL_RANGE * 2 + 1).fill(1);
}

function emphasiseRow(values: Record<number, number>): number[] {
  const row = uniformRow();
  for (const k of Object.keys(values)) {
    const idx = Number(k) + INTERVAL_RANGE;
    if (idx >= 0 && idx < row.length) row[idx] = values[Number(k)];
  }
  return row;
}

function buildLofiMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    // Bias toward small steps (-2, -1, +1, +2) and occasional thirds.
    m.push(emphasiseRow({
      "-3": 1.5, "-2": 4, "-1": 6, "0": 3, "1": 6, "2": 4, "3": 1.5,
      "-5": 0.5, "5": 0.5,
    }));
  }
  return m;
}

function buildCinematicMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    m.push(emphasiseRow({
      "-7": 1.5, "-5": 2, "-4": 1.5, "-3": 2, "-2": 2, "-1": 2,
      "0": 1, "1": 2, "2": 2, "3": 2, "4": 1.5, "5": 2, "7": 1.5,
    }));
  }
  // Slightly bias resolution downward by step after a leap up.
  for (let leap = 4; leap <= 7; leap++) {
    m[leap + INTERVAL_RANGE][-1 + INTERVAL_RANGE] *= 2.5;
    m[leap + INTERVAL_RANGE][-2 + INTERVAL_RANGE] *= 2.0;
  }
  return m;
}

function buildPopMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    m.push(emphasiseRow({
      "-2": 4, "-1": 5, "0": 2, "1": 5, "2": 4, "3": 2, "-3": 2,
      "5": 1.5, "-5": 1.5,
    }));
  }
  return m;
}

function buildAmbientMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    m.push(emphasiseRow({
      "-2": 3, "-1": 4, "0": 6, "1": 4, "2": 3,
      "-4": 1, "4": 1,
    }));
  }
  return m;
}

function buildElectronicMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    m.push(emphasiseRow({
      "-7": 1, "-5": 1.5, "-3": 2, "-2": 3, "-1": 4,
      "0": 3, "1": 4, "2": 3, "3": 2, "5": 1.5, "7": 1,
    }));
  }
  return m;
}

function buildClassicalMatrix(): IntervalMatrix {
  const m: IntervalMatrix = [];
  for (let i = -INTERVAL_RANGE; i <= INTERVAL_RANGE; i++) {
    m.push(emphasiseRow({
      "-5": 1, "-4": 1.5, "-3": 2, "-2": 5, "-1": 6,
      "0": 1, "1": 6, "2": 5, "3": 2, "4": 1.5, "5": 1,
    }));
  }
  // Apply step-after-leap convention.
  for (let leap = 3; leap <= 7; leap++) {
    m[leap + INTERVAL_RANGE][-1 + INTERVAL_RANGE] *= 3.0;
    m[-leap + INTERVAL_RANGE][1 + INTERVAL_RANGE] *= 3.0;
  }
  return m;
}

const INTERVAL_MATRICES: Record<Genre, IntervalMatrix> = {
  lofi:       buildLofiMatrix(),
  cinematic:  buildCinematicMatrix(),
  pop:        buildPopMatrix(),
  ambient:    buildAmbientMatrix(),
  electronic: buildElectronicMatrix(),
  classical:  buildClassicalMatrix(),
};

// ── Rhythm Markov tables ───────────────────────────────────────────────────

/**
 * Rhythmic patterns are encoded as 16-step grids (one bar in 4/4, 16th
 * notes). Each genre supplies a small handful of "bar prototypes" plus a
 * Markov transition matrix that chooses which bar prototype follows which.
 */
interface RhythmBank {
  /** Each pattern is a 16-element 0/1 array (0 = rest, 1 = attack). */
  patterns: number[][];
  /** Transition matrix between patterns (row sums normalised internally). */
  transitions: number[][];
  /** Velocity envelope per step (0–1). */
  velocityCurve: number[];
}

const LOFI_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0],
    [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  ],
  transitions: [
    [0.5, 0.2, 0.2, 0.1],
    [0.3, 0.4, 0.2, 0.1],
    [0.2, 0.3, 0.4, 0.1],
    [0.4, 0.2, 0.2, 0.2],
  ],
  velocityCurve: [
    1.0, 0.6, 0.7, 0.55, 0.85, 0.6, 0.7, 0.55,
    0.95, 0.6, 0.7, 0.55, 0.85, 0.6, 0.7, 0.55,
  ],
};

const POP_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0],
    [1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0],
    [1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1],
  ],
  transitions: [
    [0.4, 0.3, 0.2, 0.1],
    [0.2, 0.4, 0.3, 0.1],
    [0.2, 0.3, 0.3, 0.2],
    [0.3, 0.2, 0.2, 0.3],
  ],
  velocityCurve: [
    1.0, 0.7, 0.85, 0.7, 0.95, 0.7, 0.85, 0.7,
    1.0, 0.7, 0.85, 0.7, 0.95, 0.7, 0.85, 0.7,
  ],
};

const CINEMATIC_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  transitions: [
    [0.6, 0.2, 0.15, 0.05],
    [0.3, 0.4, 0.2, 0.1],
    [0.2, 0.3, 0.4, 0.1],
    [0.1, 0.3, 0.3, 0.3],
  ],
  velocityCurve: [
    1.0, 0.5, 0.6, 0.5, 0.95, 0.5, 0.6, 0.5,
    1.0, 0.5, 0.6, 0.5, 0.95, 0.5, 0.6, 0.5,
  ],
};

const AMBIENT_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  ],
  transitions: [
    [0.6, 0.2, 0.1, 0.1],
    [0.3, 0.4, 0.2, 0.1],
    [0.2, 0.3, 0.3, 0.2],
    [0.4, 0.3, 0.2, 0.1],
  ],
  velocityCurve: [
    0.6, 0.4, 0.45, 0.4, 0.55, 0.4, 0.45, 0.4,
    0.6, 0.4, 0.45, 0.4, 0.55, 0.4, 0.45, 0.4,
  ],
};

const ELECTRONIC_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1],
    [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  transitions: [
    [0.5, 0.2, 0.2, 0.1],
    [0.2, 0.4, 0.3, 0.1],
    [0.2, 0.3, 0.4, 0.1],
    [0.2, 0.3, 0.3, 0.2],
  ],
  velocityCurve: [
    1.0, 0.7, 0.9, 0.7, 1.0, 0.7, 0.9, 0.7,
    1.0, 0.7, 0.9, 0.7, 1.0, 0.7, 0.9, 0.7,
  ],
};

const CLASSICAL_RHYTHM: RhythmBank = {
  patterns: [
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0],
    [1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1],
    [1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0],
  ],
  transitions: [
    [0.5, 0.3, 0.15, 0.05],
    [0.3, 0.4, 0.2, 0.1],
    [0.2, 0.3, 0.4, 0.1],
    [0.3, 0.3, 0.2, 0.2],
  ],
  velocityCurve: [
    1.0, 0.6, 0.75, 0.6, 0.9, 0.6, 0.75, 0.6,
    1.0, 0.6, 0.75, 0.6, 0.9, 0.6, 0.75, 0.6,
  ],
};

const RHYTHM_BANKS: Record<Genre, RhythmBank> = {
  lofi:       LOFI_RHYTHM,
  pop:        POP_RHYTHM,
  cinematic:  CINEMATIC_RHYTHM,
  ambient:    AMBIENT_RHYTHM,
  electronic: ELECTRONIC_RHYTHM,
  classical:  CLASSICAL_RHYTHM,
};

// ── Drum patterns ──────────────────────────────────────────────────────────

const KICK = 35;
const SNARE = 38;
const CLOSED_HAT = 42;
const OPEN_HAT = 46;
const RIDE = 51;
const TOM_LOW = 41;
const TOM_HIGH = 50;
const CLAP = 39;

/** Each drum slot is a 16-step pattern of velocities (0 = rest). */
type DrumPattern = Record<number, number[]>;

const DRUM_PATTERNS = {
  lofi: {
    [KICK]:       [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [SNARE]:      [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
    [CLOSED_HAT]: [0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0],
    [OPEN_HAT]:   [0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
  } as DrumPattern,
  pop: {
    [KICK]:       [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    [SNARE]:      [0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0],
    [CLOSED_HAT]: [0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5],
    [CLAP]:       [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
  } as DrumPattern,
  cinematic: {
    [KICK]:       [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.5],
    [TOM_LOW]:    [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
    [TOM_HIGH]:   [0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0.7, 0],
    [RIDE]:       [0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0],
  } as DrumPattern,
  ambient: {
    [KICK]:       [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [CLOSED_HAT]: [0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0],
  } as DrumPattern,
  electronic: {
    [KICK]:       [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [SNARE]:      [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
    [CLOSED_HAT]: [0, 0.7, 0, 0.7, 0, 0.7, 0, 0.7, 0, 0.7, 0, 0.7, 0, 0.7, 0, 0.7],
    [OPEN_HAT]:   [0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.6],
  } as DrumPattern,
  classical: {
    [KICK]:       [0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
    [SNARE]:      [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0],
    [RIDE]:       [0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0, 0.5, 0, 0.45, 0],
  } as DrumPattern,
} as const;

// ── Chord progressions per genre/mood ──────────────────────────────────────

/**
 * Each progression is expressed as scale-degree numerals (1–7) with
 * an optional quality override (`6m` = minor sixth, `5d` = dominant 7th,
 * `4M7` = major 7th on IV). Numerals only, lowercase letters resolved
 * dynamically.
 */
type ProgressionToken = string;

interface ProgressionBank {
  /** Indexed by mood; each mood maps to an array of progressions. */
  byMood: Record<Mood, ProgressionToken[][]>;
}

const POP_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1", "5", "6m", "4"], ["1", "4", "5", "1"], ["1", "6m", "4", "5"]],
    melancholic:  [["6m", "4", "1", "5"], ["1", "5", "6m", "3m"], ["6m", "3", "4", "1"]],
    chill:        [["1maj7", "3m7", "4maj7", "5dom7"], ["1", "2m", "4", "5"]],
    dramatic:     [["6m", "4", "5", "1"], ["1", "5dom7", "6m", "3"]],
    epic:         [["1", "5", "6m", "4"], ["4", "5", "1", "1"]],
    tense:        [["1", "b2", "5", "6m"], ["6m", "b7", "1", "5"]],
  },
};

const CINEMATIC_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1", "4", "5", "6m"], ["1", "5/3", "6m", "4"]],
    melancholic:  [["6m", "4", "1", "5"], ["1m", "b6", "b7", "1m"]],
    chill:        [["1maj7", "4maj7", "6m7", "5dom7"], ["1", "2m", "4", "1"]],
    dramatic:     [["1m", "b6", "b3", "b7"], ["1m", "5", "1m", "b6"]],
    epic:         [["1", "b7", "4", "1"], ["1", "5", "b7", "4"], ["1m", "b7", "b6", "5"]],
    tense:        [["1m", "b2", "1m", "5"], ["1m", "b6", "5dom7", "1m"]],
  },
};

const LOFI_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1maj7", "3m7", "4maj7", "5dom7"], ["1", "6m", "2m", "5"]],
    melancholic:  [["6m9", "4maj7", "1maj7", "5dom7"], ["2m7", "5dom7", "1maj7", "6m7"]],
    chill:        [["1maj7", "4maj7", "6m7", "5dom7"], ["1maj7", "2m7", "3m7", "4maj7"]],
    dramatic:     [["6m", "5", "4", "5"], ["1", "5/7", "6m", "4"]],
    epic:         [["1", "4", "6m", "5"]],
    tense:        [["1m", "b6", "5dom7", "1m"]],
  },
};

const AMBIENT_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1maj7", "4maj7"], ["1add9", "4add9", "5add9", "1add9"]],
    melancholic:  [["6m9", "4maj7"], ["1m9", "b6maj7"]],
    chill:        [["1maj7", "2m7", "3m7", "4maj7"]],
    dramatic:     [["1m", "b6", "b7"], ["1m", "5", "1m"]],
    epic:         [["1", "5", "6m", "4"]],
    tense:        [["1m", "b2", "1m"]],
  },
};

const ELECTRONIC_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1", "5", "6m", "4"], ["1", "4", "6m", "5"]],
    melancholic:  [["6m", "4", "1", "5"], ["1m", "b7", "b6", "5"]],
    chill:        [["1m9", "4m9", "5m9", "1m9"]],
    dramatic:     [["1m", "b6", "5", "1m"]],
    epic:         [["1", "5", "b7", "4"], ["1m", "b7", "b6", "5"]],
    tense:        [["1m", "b2", "5", "1m"]],
  },
};

const CLASSICAL_PROGRESSIONS: ProgressionBank = {
  byMood: {
    happy:        [["1", "4", "5", "1"], ["1", "5", "6m", "3", "4", "1", "2m", "5"]],
    melancholic:  [["6m", "3", "4", "1", "2m", "5", "1"], ["1m", "5", "1m", "b6", "b3", "b7", "5"]],
    chill:        [["1", "4", "1", "5"], ["1", "2m", "5", "1"]],
    dramatic:     [["1m", "5dom7", "1m", "b6"], ["1m", "4m", "5dom7", "1m"]],
    epic:         [["1", "4", "5", "1"], ["4", "5dom7", "1", "5", "6m", "4", "5", "1"]],
    tense:        [["1m", "b2", "5dom7", "1m"]],
  },
};

const PROGRESSIONS: Record<Genre, ProgressionBank> = {
  pop:        POP_PROGRESSIONS,
  cinematic:  CINEMATIC_PROGRESSIONS,
  lofi:       LOFI_PROGRESSIONS,
  ambient:    AMBIENT_PROGRESSIONS,
  electronic: ELECTRONIC_PROGRESSIONS,
  classical:  CLASSICAL_PROGRESSIONS,
};

// ── Random helpers (mulberry32 seeded RNG) ─────────────────────────────────

/**
 * Fast deterministic PRNG. Same seed always produces the same sequence,
 * regardless of host platform.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Force unsigned 32-bit. 0 is allowed but maps to a non-degenerate state.
    this.state = (seed >>> 0) || 0x9E3779B9;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive. */
  intBetween(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a float in [min, max). */
  floatBetween(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** Picks one element from `arr` uniformly. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error("SeededRandom.pick called with empty array");
    }
    return arr[this.intBetween(0, arr.length - 1)];
  }

  /** Picks an index from a weights array (weights need not be normalised). */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return 0;
    let target = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i];
      if (target <= 0) return i;
    }
    return weights.length - 1;
  }
}

// ── Music theory helpers ───────────────────────────────────────────────────

/** Convert a MIDI pitch to its Hz frequency. */
export function midiToFrequency(midi: number): number {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Convert a MIDI pitch to a human-readable note name (e.g. "F#4"). */
export function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${PITCH_CLASS_NAMES[pc]}${octave}`;
}

/** Returns the pitches (MIDI) for one octave of `key` starting at `tonic`. */
export function scalePitches(key: MusicalKey, octave: number): number[] {
  const intervals = SCALE_INTERVALS[key.scale];
  const base = (octave + 1) * 12 + key.tonic; // octave 4 → middle C area
  return intervals.map((iv) => base + iv);
}

/**
 * Returns the closest pitch in `key` to `target`, optionally constrained
 * to a maximum number of semitones away.
 */
export function snapToKey(key: MusicalKey, target: number, maxDelta = 12): number {
  const intervals = SCALE_INTERVALS[key.scale];
  let best = target;
  let bestDelta = Infinity;
  // Search ±2 octaves.
  for (let oct = -2; oct <= 2; oct++) {
    const base = Math.floor(target / 12) * 12 + oct * 12 + key.tonic;
    for (const iv of intervals) {
      const candidate = base + iv;
      const delta = Math.abs(candidate - target);
      if (delta < bestDelta && delta <= maxDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
  }
  return best;
}

/** Quality letters resolved against the diatonic table. */
function qualityForDegree(key: MusicalKey, degreeIndex: number): string {
  const isMinorKey = key.scale === "minor" || key.scale === "harmonicMinor";
  const table = isMinorKey ? MINOR_DIATONIC_QUALITIES : MAJOR_DIATONIC_QUALITIES;
  return table[degreeIndex % table.length];
}

/** Extract degree number, accidental, and quality suffix from a token. */
function parseProgressionToken(token: string): {
  flat: boolean;
  sharp: boolean;
  degree: number;
  qualitySuffix: string;
  inversion?: number;
} {
  let i = 0;
  let flat = false;
  let sharp = false;
  if (token[i] === "b") { flat = true; i++; }
  else if (token[i] === "#") { sharp = true; i++; }
  let degStr = "";
  while (i < token.length && /[0-9]/.test(token[i])) {
    degStr += token[i];
    i++;
  }
  const degree = parseInt(degStr || "1", 10);
  let qualitySuffix = "";
  let inversion: number | undefined;
  while (i < token.length) {
    if (token[i] === "/") {
      const inv = parseInt(token.slice(i + 1), 10);
      if (!Number.isNaN(inv)) inversion = inv;
      break;
    }
    qualitySuffix += token[i];
    i++;
  }
  return { flat, sharp, degree, qualitySuffix, inversion };
}

/** Returns the chord pitches (MIDI) for a progression token. */
export function chordPitchesForToken(
  key: MusicalKey,
  token: string,
  octave: number,
): number[] {
  const { flat, sharp, degree, qualitySuffix, inversion } = parseProgressionToken(token);
  const intervals = SCALE_INTERVALS[key.scale];
  const wrappedDegree = ((degree - 1) % intervals.length + intervals.length) % intervals.length;
  let rootSemis = intervals[wrappedDegree];
  if (flat) rootSemis -= 1;
  if (sharp) rootSemis += 1;
  const rootMidi = (octave + 1) * 12 + key.tonic + rootSemis;

  let qualityKey = "";
  const suffix = qualitySuffix.trim().toLowerCase();

  if (suffix.startsWith("maj7")) qualityKey = "maj7";
  else if (suffix.startsWith("min7")) qualityKey = "min7";
  else if (suffix.startsWith("dom7")) qualityKey = "dom7";
  else if (suffix.startsWith("min9")) qualityKey = "min9";
  else if (suffix.startsWith("add9")) qualityKey = "add9";
  else if (suffix.startsWith("sus2")) qualityKey = "sus2";
  else if (suffix.startsWith("sus4")) qualityKey = "sus4";
  else if (suffix.startsWith("m7b5")) qualityKey = "m7b5";
  else if (suffix.startsWith("m7")) qualityKey = "min7";
  else if (suffix === "m") qualityKey = "min";
  else if (suffix === "d") qualityKey = "dom7";
  else if (suffix === "M") qualityKey = "maj";
  else if (suffix === "" || suffix === "maj" || suffix === "min" || suffix === "dim") {
    qualityKey = suffix || qualityForDegree(key, wrappedDegree);
  } else {
    qualityKey = qualityForDegree(key, wrappedDegree);
  }
  const template = CHORD_INTERVALS[qualityKey] ?? CHORD_INTERVALS["maj"];
  let pitches = template.map((iv) => rootMidi + iv);
  if (inversion && inversion > 0 && inversion < pitches.length) {
    for (let i = 0; i < inversion; i++) {
      pitches[i] += 12;
    }
    pitches = pitches.slice().sort((a, b) => a - b);
  }
  return pitches;
}

// ── Composer ───────────────────────────────────────────────────────────────

/** Internal: 16-step rhythm grid context. */
interface BarContext {
  bar: number;
  startSec: number;
  beatsPerBar: number;
  secondsPerBeat: number;
  swing: number;
  marker: BlueprintMarker;
  intensity: number;
}

/**
 * Main composer class. Stateless across `generate` calls (each call creates
 * a fresh `SeededRandom`) so the same options always yield the same
 * `Composition`.
 */
export class MelodyGenerator {
  /**
   * Generate a complete composition from a music blueprint.
   *
   * Throws if the blueprint is empty or invalid.
   */
  generate(options: GenerateOptions): Composition {
    if (!options.blueprint || options.blueprint.markers.length === 0) {
      throw new Error("MelodyGenerator.generate requires a non-empty blueprint");
    }
    const seed = options.seed ?? Math.floor(Math.random() * 0xFFFFFFFF);
    const rng = new SeededRandom(seed);
    const profile = GENRE_PROFILES[options.genre];

    const bpm = this.chooseBpm(options, profile);
    const beatsPerBar = 4;
    const secondsPerBeat = 60 / bpm;
    const key = this.chooseKey(options, profile, rng);

    const events: NoteEvent[] = [];

    // Walk markers and compose bar-by-bar.
    const markers = this.smoothBlueprint(options.blueprint, secondsPerBeat * beatsPerBar);
    let cursorSec = 0;
    let activeProgression = this.chooseProgression(options.genre, markers[0].mood, rng);
    let progressionIndex = 0;
    let bar = 0;

    let prevMelodyPitch = profile.melodyCentre;
    let lastRhythmPattern = rng.intBetween(0, RHYTHM_BANKS[options.genre].patterns.length - 1);

    const masterIntensity = clamp01(options.intensity ?? 0.7);

    while (cursorSec < options.blueprint.durationSec - 1e-3) {
      const marker = this.markerAtTime(markers, cursorSec);
      // Re-pick progression at marker boundaries for fresh harmonic shape.
      if (this.isMarkerBoundary(markers, cursorSec, secondsPerBeat * beatsPerBar)) {
        activeProgression = this.chooseProgression(options.genre, marker.mood, rng);
        progressionIndex = 0;
      }

      const ctx: BarContext = {
        bar,
        startSec: cursorSec,
        beatsPerBar,
        secondsPerBeat,
        swing: profile.swing,
        marker,
        intensity: clamp01(marker.intensity * masterIntensity + 0.05),
      };

      // Choose chord token for this bar.
      const chordToken = activeProgression[progressionIndex % activeProgression.length];
      progressionIndex++;
      const chordPitches = chordPitchesForToken(key, chordToken, Math.floor(profile.chordCentre / 12) - 1);

      // Emit chord events (sustained for the full bar).
      this.emitChord(events, ctx, chordPitches, profile);

      // Emit bass events (root note rhythm).
      this.emitBass(events, ctx, chordPitches[0], profile, rng);

      // Emit melody events using Markov interval walker.
      const { lastPitch, nextRhythmIdx } = this.emitMelody(
        events,
        ctx,
        key,
        chordPitches,
        profile,
        options.genre,
        rng,
        prevMelodyPitch,
        lastRhythmPattern,
      );
      prevMelodyPitch = lastPitch;
      lastRhythmPattern = nextRhythmIdx;

      // Emit drums (mood-aware density).
      this.emitDrums(events, ctx, profile);

      bar++;
      cursorSec += secondsPerBeat * beatsPerBar;
    }

    // Sort events by start time for deterministic playback.
    events.sort((a, b) => a.startSec - b.startSec);

    return {
      genre: options.genre,
      bpm,
      beatsPerBar,
      key,
      events,
      durationSec: options.blueprint.durationSec,
      trackStats: this.computeStats(events),
      seed,
    };
  }

  /** Build a default blueprint from a single mood/pacing pair. */
  buildBlueprint(
    durationSec: number,
    mood: Mood,
    pacing: Pacing,
    intensity = 0.7,
  ): MusicBlueprint {
    return {
      durationSec,
      markers: [{ startSec: 0, endSec: durationSec, mood, pacing, intensity }],
    };
  }

  // ── Choice helpers ───────────────────────────────────────────────────────

  private chooseBpm(opts: GenerateOptions, profile: GenreProfile): number {
    if (opts.bpmOverride && opts.bpmOverride > 0) {
      return clampNum(opts.bpmOverride, profile.bpmRange.min - 20, profile.bpmRange.max + 40);
    }
    // Use blueprint pacing if available.
    const fastWeight = opts.blueprint.markers.reduce((a, m) => a + (m.pacing === "fast" ? 1 : 0), 0);
    const slowWeight = opts.blueprint.markers.reduce((a, m) => a + (m.pacing === "slow" ? 1 : 0), 0);
    const total = opts.blueprint.markers.length;
    const fastRatio = fastWeight / Math.max(1, total);
    const slowRatio = slowWeight / Math.max(1, total);
    const range = profile.bpmRange;
    const t = 0.5 + fastRatio * 0.5 - slowRatio * 0.5;
    const bpm = range.min + (range.max - range.min) * clamp01(t);
    return Math.round(bpm);
  }

  private chooseKey(
    opts: GenerateOptions,
    profile: GenreProfile,
    rng: SeededRandom,
  ): MusicalKey {
    const tonic = rng.pick(profile.preferredTonics);
    const dominantMood = this.dominantMood(opts.blueprint);
    const useDarkScale = dominantMood === "dramatic"
      || dominantMood === "melancholic"
      || dominantMood === "tense";
    return { tonic, scale: useDarkScale ? profile.darkScale : profile.brightScale };
  }

  private dominantMood(blueprint: MusicBlueprint): Mood {
    const counts = new Map<Mood, number>();
    for (const m of blueprint.markers) {
      counts.set(m.mood, (counts.get(m.mood) ?? 0) + (m.endSec - m.startSec));
    }
    let best: Mood = "chill";
    let bestVal = -1;
    for (const [mood, val] of counts) {
      if (val > bestVal) {
        bestVal = val;
        best = mood;
      }
    }
    return best;
  }

  private chooseProgression(
    genre: Genre,
    mood: Mood,
    rng: SeededRandom,
  ): ProgressionToken[] {
    const bank = PROGRESSIONS[genre].byMood[mood];
    if (bank && bank.length > 0) return rng.pick(bank);
    // Fallback: borrow from "chill" or first available.
    const chill = PROGRESSIONS[genre].byMood.chill;
    if (chill && chill.length > 0) return rng.pick(chill);
    return ["1", "4", "5", "1"];
  }

  private smoothBlueprint(blueprint: MusicBlueprint, barSec: number): BlueprintMarker[] {
    if (blueprint.markers.length === 0) return [];
    // Snap marker boundaries to whole bars so chord changes align cleanly.
    return blueprint.markers.map((m) => ({
      ...m,
      startSec: Math.floor(m.startSec / barSec) * barSec,
      endSec: Math.ceil(m.endSec / barSec) * barSec,
      intensity: clamp01(m.intensity),
    }));
  }

  private markerAtTime(markers: BlueprintMarker[], time: number): BlueprintMarker {
    for (const m of markers) {
      if (time >= m.startSec && time < m.endSec) return m;
    }
    return markers[markers.length - 1];
  }

  private isMarkerBoundary(
    markers: BlueprintMarker[],
    time: number,
    barSec: number,
  ): boolean {
    for (const m of markers) {
      if (Math.abs(time - m.startSec) < barSec * 0.5) return true;
    }
    return false;
  }

  // ── Track emitters ───────────────────────────────────────────────────────

  private emitChord(
    events: NoteEvent[],
    ctx: BarContext,
    pitches: number[],
    profile: GenreProfile,
  ): void {
    const dur = ctx.secondsPerBeat * ctx.beatsPerBar;
    const baseVel = 0.35 + ctx.intensity * 0.25;
    for (const pitch of pitches) {
      events.push({
        track: "chords",
        pitch,
        velocity: clamp01(baseVel),
        startSec: ctx.startSec,
        durationSec: dur * 0.95,
        timbre: profile.timbres.chords,
        articulation: "legato",
      });
    }
  }

  private emitBass(
    events: NoteEvent[],
    ctx: BarContext,
    rootPitch: number,
    profile: GenreProfile,
    rng: SeededRandom,
  ): void {
    // Move root down into bass range.
    let bassPitch = rootPitch;
    while (bassPitch > profile.bassCentre + 6) bassPitch -= 12;
    while (bassPitch < profile.bassCentre - 6) bassPitch += 12;
    const beats = ctx.beatsPerBar;
    const stepSec = ctx.secondsPerBeat / 2; // 8th-note grid for bass
    const stepCount = beats * 2;
    const baseVel = 0.55 + ctx.intensity * 0.3;
    for (let s = 0; s < stepCount; s++) {
      const onBeat = s % 2 === 0;
      const prob = onBeat ? profile.bassDensity : profile.bassDensity * 0.35;
      if (rng.next() < prob) {
        const pitch = onBeat ? bassPitch : (rng.next() < 0.3 ? bassPitch + 7 : bassPitch);
        events.push({
          track: "bass",
          pitch,
          velocity: clamp01(baseVel + (onBeat ? 0.05 : -0.1)),
          startSec: ctx.startSec + s * stepSec,
          durationSec: stepSec * 0.9,
          timbre: profile.timbres.bass,
          articulation: onBeat ? "tenuto" : "staccato",
        });
      }
    }
  }

  private emitMelody(
    events: NoteEvent[],
    ctx: BarContext,
    key: MusicalKey,
    chordPitches: number[],
    profile: GenreProfile,
    genre: Genre,
    rng: SeededRandom,
    prevPitch: number,
    lastRhythmIdx: number,
  ): { lastPitch: number; nextRhythmIdx: number } {
    const bank = RHYTHM_BANKS[genre];
    const nextRhythmIdx = rng.weightedIndex(bank.transitions[lastRhythmIdx]);
    const pattern = bank.patterns[nextRhythmIdx];
    const stepSec = ctx.secondsPerBeat / 4; // 16th notes
    const intervalMatrix = INTERVAL_MATRICES[genre];
    let pitch = snapToKey(key, prevPitch);
    let prevInterval = 0;
    for (let step = 0; step < pattern.length; step++) {
      const probMul = pattern[step] === 1 ? 1.0 : 0.15;
      const triggered = rng.next() < profile.melodyDensity * probMul * (0.5 + ctx.intensity * 0.7);
      if (!triggered) continue;

      // Choose next interval from Markov matrix.
      const row = intervalMatrix[clampNum(prevInterval, -INTERVAL_RANGE, INTERVAL_RANGE) + INTERVAL_RANGE];
      const idx = rng.weightedIndex(row);
      const semitones = idx - INTERVAL_RANGE;

      let candidate = pitch + semitones;
      // Bias toward chord tones on strong beats.
      if (step % 4 === 0 && rng.next() < 0.55 && chordPitches.length > 0) {
        const target = chordPitches[rng.intBetween(0, chordPitches.length - 1)];
        candidate = nearestOctave(candidate, target);
      } else {
        candidate = snapToKey(key, candidate, 6);
      }

      // Keep melody within ±octave of profile centre.
      while (candidate > profile.melodyCentre + 12) candidate -= 12;
      while (candidate < profile.melodyCentre - 12) candidate += 12;

      const swingOffset = (step % 2 === 1) ? ctx.swing * stepSec : 0;
      const startSec = ctx.startSec + step * stepSec + swingOffset;
      const dur = stepSec * (rng.next() < 0.2 ? 1.8 : 0.9);
      const baseVel = bank.velocityCurve[step] * (0.5 + ctx.intensity * profile.dynamics);

      events.push({
        track: "melody",
        pitch: candidate,
        velocity: clamp01(baseVel),
        startSec,
        durationSec: dur,
        timbre: profile.timbres.melody,
        articulation: dur > stepSec ? "legato" : "staccato",
      });

      prevInterval = candidate - pitch;
      pitch = candidate;
    }
    return { lastPitch: pitch, nextRhythmIdx };
  }

  private emitDrums(
    events: NoteEvent[],
    ctx: BarContext,
    profile: GenreProfile,
  ): void {
    const pattern = DRUM_PATTERNS[profile.drumPattern] as DrumPattern;
    const stepSec = ctx.secondsPerBeat / 4;
    const intensityScale = 0.5 + ctx.intensity * 0.6;
    for (const slot of Object.keys(pattern)) {
      const drumPitch = Number(slot);
      const grid = pattern[drumPitch];
      for (let step = 0; step < grid.length; step++) {
        const v = grid[step];
        if (!v) continue;
        events.push({
          track: "percussion",
          pitch: drumPitch,
          velocity: clamp01(v * intensityScale),
          startSec: ctx.startSec + step * stepSec,
          durationSec: stepSec * 0.6,
          timbre: profile.timbres.percussion,
          articulation: "accent",
        });
      }
    }
  }

  private computeStats(events: NoteEvent[]): Record<InstrumentTrack, TrackStats> {
    const init = (): TrackStats => ({
      noteCount: 0,
      averagePitch: 0,
      minPitch: Infinity,
      maxPitch: -Infinity,
    });
    const stats: Record<InstrumentTrack, TrackStats> = {
      melody: init(),
      bass: init(),
      chords: init(),
      percussion: init(),
    };
    const sums: Record<InstrumentTrack, number> = {
      melody: 0, bass: 0, chords: 0, percussion: 0,
    };
    for (const ev of events) {
      const s = stats[ev.track];
      s.noteCount++;
      sums[ev.track] += ev.pitch;
      if (ev.pitch < s.minPitch) s.minPitch = ev.pitch;
      if (ev.pitch > s.maxPitch) s.maxPitch = ev.pitch;
    }
    for (const t of Object.keys(stats) as InstrumentTrack[]) {
      const s = stats[t];
      if (s.noteCount > 0) {
        s.averagePitch = sums[t] / s.noteCount;
      } else {
        s.minPitch = 0;
        s.maxPitch = 0;
      }
    }
    return stats;
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampNum(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function nearestOctave(pitch: number, target: number): number {
  // Move `target` to the octave closest to `pitch`.
  let candidate = target;
  while (candidate - pitch > 6) candidate -= 12;
  while (pitch - candidate > 6) candidate += 12;
  return candidate;
}

// ── Public utility exports ─────────────────────────────────────────────────

/** Returns a list of all registered genres (for UI dropdowns). */
export function listGenres(): Genre[] {
  return Object.keys(GENRE_PROFILES) as Genre[];
}

/** Returns the human-readable display name for a genre. */
export function genreDisplayName(genre: Genre): string {
  switch (genre) {
    case "lofi":       return "Lo-Fi";
    case "cinematic":  return "Cinematic";
    case "pop":        return "Pop";
    case "ambient":    return "Ambient";
    case "electronic": return "Electronic";
    case "classical":  return "Classical";
  }
}

/** Returns the human-readable display name for a mood. */
export function moodDisplayName(mood: Mood): string {
  switch (mood) {
    case "happy":        return "Happy";
    case "dramatic":     return "Dramatic";
    case "chill":        return "Chill";
    case "epic":         return "Epic";
    case "melancholic":  return "Melancholic";
    case "tense":        return "Tense";
  }
}

/** Returns all moods (for UI). */
export function listMoods(): Mood[] {
  return ["happy", "chill", "melancholic", "dramatic", "epic", "tense"];
}

/** Returns all pacing values (for UI). */
export function listPacing(): Pacing[] {
  return ["slow", "medium", "fast"];
}

/** Default tempo for a given genre, used when no override is supplied. */
export function defaultBpmForGenre(genre: Genre): number {
  return GENRE_PROFILES[genre].defaultBpm;
}

/** Returns true if `genre` is a recognised value. */
export function isGenre(value: string): value is Genre {
  return value in GENRE_PROFILES;
}

/** Singleton instance for app-wide use. */
export const melodyGenerator = new MelodyGenerator();
