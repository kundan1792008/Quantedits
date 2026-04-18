/**
 * MelodyGenerator — Markov-chain MIDI composition engine
 *
 * Generates four-voice MIDI arrangements (melody, bass, chords/pad,
 * percussion) whose style, tempo, and key are driven by a MusicBlueprint
 * produced by MusicAnalyzer.
 *
 * Design notes
 * ─────────────
 * • All note data is first-order Markov chains trained on synthetic genre
 *   fingerprints.  The transitions encode the conditional probability of
 *   moving from pitch P to pitch Q within the same scale.
 * • Tempo adapts to the blueprint's `suggestedBpm`; bar positions are
 *   aligned to scene-cut timestamps so musical phrases can turn around at
 *   cinematically meaningful moments.
 * • Each instrument track carries per-note velocity, duration (in beats),
 *   and start time (in beats).  The AudioSynthesizer converts beats → seconds
 *   using the bpm field embedded in the MIDIComposition.
 */

import type { MusicBlueprint, VideoMood, VideoPacing } from "./MusicAnalyzer";

// ── Public types ─────────────────────────────────────────────────────────────

export type Genre =
  | "lo-fi"
  | "cinematic"
  | "pop"
  | "ambient"
  | "electronic"
  | "classical";

export interface MIDINote {
  /** MIDI pitch 0–127. */
  pitch: number;
  /** Note-on velocity 1–127. */
  velocity: number;
  /** Start time in beats (relative to track start). */
  startBeat: number;
  /** Duration in beats. */
  durationBeats: number;
}

export interface InstrumentTrack {
  name: "melody" | "bass" | "chords" | "percussion";
  notes: MIDINote[];
  /** Default output volume 0–1. */
  defaultVolume: number;
  /** Channel: 0-based MIDI channel. */
  channel: number;
  /** MIDI program number 0–127. */
  program: number;
}

export interface MIDIComposition {
  bpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  totalBeats: number;
  genre: Genre;
  key: string;
  tracks: InstrumentTrack[];
  /** Timestamps (in beats) where a key change or major transition occurs. */
  sectionBoundaries: number[];
}

export interface GeneratorOptions {
  genre?: Genre;
  /** Override BPM; if omitted, uses blueprint.suggestedBpm. */
  bpmOverride?: number;
  /** Override key; if omitted, uses blueprint.suggestedKey. */
  keyOverride?: string;
  /** Intensity scalar 0–1 applied to velocity. Default: 0.8. */
  intensityScale?: number;
  /** Seed for deterministic output.  Default: Date.now(). */
  seed?: number;
  timeSignatureNumerator?: number;
  timeSignatureDenominator?: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

type MarkovTable = Record<number, Array<{ pitch: number; weight: number }>>;

interface GenreProfile {
  /** Scale degrees 0–11 (relative to root). */
  scaleDegrees: number[];
  /**
   * Markov transition weights per scale-degree index.
   * Outer key = current degree index, inner = list of (next index, weight).
   */
  transitionWeights: number[][];
  /** Velocity range [min, max]. */
  velocityRange: [number, number];
  /** How many bars a typical phrase spans. */
  phraseLength: number;
  /** MIDI program for melody, bass, chords (in that order). */
  programs: [number, number, number];
  /** Typical note durations in beats for melody. */
  noteDurations: number[];
  /** Typical note durations for bass (often longer). */
  bassDurations: number[];
  /** Chord hold duration in beats. */
  chordDuration: number;
  /** Bass octave relative to middle C. */
  bassOctave: number;
  /** Chords octave relative to middle C. */
  chordsOctave: number;
}

// ── Genre profiles ────────────────────────────────────────────────────────────

/**
 * Minor pentatonic: 0, 3, 5, 7, 10 — lo-fi staple.
 */
const LOFI_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 3, 5, 7, 10],
  transitionWeights: [
    [3, 2, 1, 1, 1],  // from 0 → 3,5,7,10,0
    [1, 3, 2, 1, 1],
    [1, 1, 3, 2, 1],
    [1, 1, 2, 3, 2],
    [2, 1, 1, 2, 3],
  ],
  velocityRange:  [45, 72],
  phraseLength:   4,
  programs:       [0, 32, 88],       // piano, acoustic bass, pad
  noteDurations:  [0.5, 1, 1, 1.5],
  bassDurations:  [1, 2, 2],
  chordDuration:  4,
  bassOctave:     -2,
  chordsOctave:   -1,
};

/**
 * Natural minor scale: 0,2,3,5,7,8,10 — cinematic foundation.
 */
const CINEMATIC_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 2, 3, 5, 7, 8, 10],
  transitionWeights: [
    [1, 2, 3, 2, 2, 1, 1],
    [2, 1, 2, 3, 1, 1, 1],
    [1, 2, 1, 3, 2, 2, 1],
    [2, 1, 2, 1, 3, 2, 1],
    [1, 1, 2, 2, 1, 3, 2],
    [1, 2, 1, 2, 3, 1, 2],
    [3, 1, 2, 1, 2, 2, 1],
  ],
  velocityRange:  [55, 105],
  phraseLength:   8,
  programs:       [48, 32, 88],     // strings, acoustic bass, choir pad
  noteDurations:  [1, 2, 2, 4],
  bassDurations:  [2, 4],
  chordDuration:  8,
  bassOctave:     -2,
  chordsOctave:   -1,
};

/**
 * Major scale: 0,2,4,5,7,9,11 — pop energy.
 */
const POP_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 2, 4, 5, 7, 9, 11],
  transitionWeights: [
    [1, 2, 3, 2, 3, 1, 1],
    [2, 1, 3, 2, 2, 2, 1],
    [1, 2, 1, 3, 2, 2, 2],
    [2, 1, 3, 1, 3, 1, 1],
    [3, 2, 2, 2, 1, 2, 1],
    [1, 2, 2, 1, 2, 1, 3],
    [3, 1, 2, 1, 2, 2, 1],
  ],
  velocityRange:  [65, 100],
  phraseLength:   4,
  programs:       [0, 33, 81],     // piano, fingered bass, synth lead
  noteDurations:  [0.25, 0.5, 0.5, 1],
  bassDurations:  [1, 2],
  chordDuration:  2,
  bassOctave:     -2,
  chordsOctave:   -1,
};

/**
 * Lydian scale: 0,2,4,6,7,9,11 — dreamy ambient quality.
 */
const AMBIENT_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 2, 4, 6, 7, 9, 11],
  transitionWeights: [
    [2, 2, 2, 1, 2, 1, 1],
    [1, 2, 2, 2, 2, 1, 1],
    [2, 1, 2, 2, 1, 2, 1],
    [1, 2, 1, 2, 2, 2, 1],
    [2, 1, 2, 1, 2, 2, 1],
    [1, 2, 2, 1, 2, 1, 2],
    [2, 1, 1, 2, 2, 1, 2],
  ],
  velocityRange:  [30, 60],
  phraseLength:   16,
  programs:       [88, 32, 91],   // pad, acoustic bass, slow strings
  noteDurations:  [2, 4, 4, 8],
  bassDurations:  [4, 8],
  chordDuration:  16,
  bassOctave:     -2,
  chordsOctave:   -1,
};

/**
 * Dorian mode: 0,2,3,5,7,9,10 — groovy electronic base.
 */
const ELECTRONIC_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 2, 3, 5, 7, 9, 10],
  transitionWeights: [
    [1, 3, 2, 2, 3, 1, 1],
    [2, 1, 3, 2, 2, 1, 1],
    [1, 2, 1, 3, 2, 2, 1],
    [2, 1, 3, 1, 3, 1, 2],
    [3, 1, 2, 2, 1, 2, 2],
    [1, 2, 1, 2, 2, 1, 3],
    [3, 1, 2, 1, 2, 3, 1],
  ],
  velocityRange:  [70, 115],
  phraseLength:   4,
  programs:       [80, 38, 90],   // synth square, synth bass, warm pad
  noteDurations:  [0.25, 0.25, 0.5, 0.5],
  bassDurations:  [0.5, 1],
  chordDuration:  2,
  bassOctave:     -2,
  chordsOctave:   -1,
};

/**
 * Harmonic minor: 0,2,3,5,7,8,11 — classical drama.
 */
const CLASSICAL_PROFILE: GenreProfile = {
  scaleDegrees:      [0, 2, 3, 5, 7, 8, 11],
  transitionWeights: [
    [1, 2, 3, 2, 3, 1, 2],
    [2, 1, 2, 3, 2, 1, 1],
    [1, 2, 1, 3, 2, 2, 2],
    [2, 1, 3, 1, 3, 2, 1],
    [3, 2, 2, 2, 1, 2, 2],
    [1, 2, 2, 1, 2, 1, 3],
    [4, 1, 2, 1, 2, 2, 1],
  ],
  velocityRange:  [50, 110],
  phraseLength:   8,
  programs:       [48, 32, 49],   // strings, acoustic bass, strings 2
  noteDurations:  [0.5, 0.5, 1, 1, 2],
  bassDurations:  [1, 2, 2],
  chordDuration:  4,
  bassOctave:     -2,
  chordsOctave:   -1,
};

const GENRE_PROFILES: Record<Genre, GenreProfile> = {
  "lo-fi":      LOFI_PROFILE,
  cinematic:    CINEMATIC_PROFILE,
  pop:          POP_PROFILE,
  ambient:      AMBIENT_PROFILE,
  electronic:   ELECTRONIC_PROFILE,
  classical:    CLASSICAL_PROFILE,
};

// ── Percussion patterns (indexed by genre) ────────────────────────────────────

interface PercussionPattern {
  /** MIDI pitch representing this drum voice. */
  pitch: number;
  /** Beat positions within a bar where hits occur (0-based). */
  beats: number[];
  velocityRange: [number, number];
}

const DRUM_PATTERNS: Record<Genre, PercussionPattern[]> = {
  "lo-fi": [
    { pitch: 36, beats: [0, 2],         velocityRange: [55, 75] },  // kick
    { pitch: 38, beats: [1, 3],         velocityRange: [50, 70] },  // snare
    { pitch: 42, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], velocityRange: [40, 60] }, // hi-hat
  ],
  cinematic: [
    { pitch: 36, beats: [0, 3],         velocityRange: [80, 110] }, // kick
    { pitch: 49, beats: [2],            velocityRange: [70, 90] },  // crash
    { pitch: 47, beats: [0.5, 1, 1.5, 2.5, 3, 3.5], velocityRange: [50, 75] }, // tom
  ],
  pop: [
    { pitch: 36, beats: [0, 2],         velocityRange: [80, 110] }, // kick
    { pitch: 38, beats: [1, 3],         velocityRange: [75, 100] }, // snare
    { pitch: 42, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], velocityRange: [60, 90] },
    { pitch: 46, beats: [2],            velocityRange: [65, 80] },  // open hat
  ],
  ambient: [
    { pitch: 49, beats: [0],            velocityRange: [25, 40] },  // very soft crash
    { pitch: 47, beats: [2],            velocityRange: [20, 35] },
  ],
  electronic: [
    { pitch: 36, beats: [0, 1, 2, 3],  velocityRange: [90, 120] }, // four-on-floor
    { pitch: 38, beats: [1, 3],         velocityRange: [80, 105] },
    { pitch: 42, beats: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75], velocityRange: [50, 80] },
  ],
  classical: [
    { pitch: 47, beats: [0, 1.5, 3],   velocityRange: [40, 65] },
    { pitch: 49, beats: [2],            velocityRange: [30, 50] },
  ],
};

// ── Note pitch helpers ─────────────────────────────────────────────────────────

/** Root note pitches: C=0, C#=1, D=2, … B=11 */
const NOTE_ROOTS: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3,
  E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8,
  Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

/**
 * Parse a key string like "Am", "F#", "Bb" into a root MIDI pitch offset
 * and a boolean indicating whether it is minor.
 */
function parseKey(key: string): { root: number; isMinor: boolean } {
  const minor = key.endsWith("m");
  const rootStr = minor ? key.slice(0, -1) : key;
  const root = NOTE_ROOTS[rootStr] ?? 0;
  return { root, isMinor: minor };
}

/**
 * Build the absolute MIDI pitches for a scale profile and a root/octave.
 */
function buildScale(
  scaleDegrees: number[],
  root: number,
  octave: number,
): number[] {
  const baseC = 60 + (octave * 12); // middle C = 60
  return scaleDegrees.map(d => Math.max(0, Math.min(127, baseC + root + d)));
}

// ── Markov chain helpers ──────────────────────────────────────────────────────

/**
 * Build a lookup table from raw GenreProfile transition weights.
 * pitches: the absolute MIDI pitch list for the scale.
 */
function buildMarkovTable(
  pitches: number[],
  weights: number[][],
): MarkovTable {
  const table: MarkovTable = {};
  for (let i = 0; i < pitches.length; i++) {
    const row = weights[i] ?? weights[0];
    table[pitches[i]] = pitches.map((pitch, j) => ({
      pitch,
      weight: row[j] ?? 1,
    }));
  }
  return table;
}

/**
 * Sample the next pitch from a Markov table given the current pitch.
 */
function markovNext(
  current: number,
  table: MarkovTable,
  rng: () => number,
): number {
  const options = table[current];
  if (!options || options.length === 0) return current;
  const totalWeight = options.reduce((s, o) => s + o.weight, 0);
  let r = rng() * totalWeight;
  for (const option of options) {
    r -= option.weight;
    if (r <= 0) return option.pitch;
  }
  return options[options.length - 1].pitch;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class MelodyGenerator {
  private rng: () => number;

  constructor(private readonly seed: number = Date.now()) {
    this.rng = this.seededRng(seed);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a complete four-track MIDI composition driven by the blueprint.
   */
  compose(blueprint: MusicBlueprint, opts: GeneratorOptions = {}): MIDIComposition {
    const genre    = opts.genre        ?? this.inferGenre(blueprint.overallMood, blueprint.pacing);
    const bpm      = opts.bpmOverride  ?? blueprint.suggestedBpm;
    const key      = opts.keyOverride  ?? blueprint.suggestedKey;
    const intensity = opts.intensityScale ?? 0.8;
    const timeSigN  = opts.timeSignatureNumerator   ?? 4;
    const timeSigD  = opts.timeSignatureDenominator ?? 4;

    // Re-seed so the same blueprint + options always produce the same output
    this.rng = this.seededRng(opts.seed ?? this.seed);

    const profile = GENRE_PROFILES[genre];
    const { root } = parseKey(key);
    const totalBeats = Math.ceil((blueprint.durationSec / 60) * bpm);

    const melodyPitches  = buildScale(profile.scaleDegrees, root, 0);
    const bassPitches    = buildScale(profile.scaleDegrees, root, profile.bassOctave);
    const chordsPitches  = buildScale(profile.scaleDegrees, root, profile.chordsOctave);
    const melodyTable    = buildMarkovTable(melodyPitches, profile.transitionWeights);
    const bassTable      = buildMarkovTable(bassPitches,   profile.transitionWeights);

    const sectionBoundaries = this.computeSectionBoundaries(
      blueprint, bpm, timeSigN,
    );

    const melodyTrack     = this.generateMelodyTrack(
      melodyTable, melodyPitches, profile, totalBeats, sectionBoundaries, intensity,
    );
    const bassTrack       = this.generateBassTrack(
      bassTable, bassPitches, profile, totalBeats, sectionBoundaries, intensity,
    );
    const chordsTrack     = this.generateChordsTrack(
      chordsPitches, profile, totalBeats, sectionBoundaries, intensity,
    );
    const percussionTrack = this.generatePercussionTrack(
      genre, profile, totalBeats, timeSigN, blueprint.intensityCurve, bpm, intensity,
    );

    return {
      bpm,
      timeSignatureNumerator: timeSigN,
      timeSignatureDenominator: timeSigD,
      totalBeats,
      genre,
      key,
      tracks: [melodyTrack, bassTrack, chordsTrack, percussionTrack],
      sectionBoundaries,
    };
  }

  // ── Genre inference ────────────────────────────────────────────────────────

  private inferGenre(mood: VideoMood, pacing: VideoPacing): Genre {
    const map: Record<VideoMood, Partial<Record<VideoPacing, Genre>>> = {
      happy:       { fast: "pop",        medium: "pop",        slow: "lo-fi" },
      dramatic:    { fast: "cinematic",  medium: "cinematic",  slow: "classical" },
      chill:       { fast: "lo-fi",      medium: "lo-fi",      slow: "ambient" },
      epic:        { fast: "electronic", medium: "cinematic",  slow: "cinematic" },
      melancholic: { fast: "classical",  medium: "ambient",    slow: "ambient" },
      tense:       { fast: "electronic", medium: "electronic", slow: "cinematic" },
    };
    return map[mood]?.[pacing] ?? "cinematic";
  }

  // ── Section boundaries ─────────────────────────────────────────────────────

  private computeSectionBoundaries(
    blueprint: MusicBlueprint,
    bpm: number,
    timeSigN: number,
  ): number[] {
    const beatsPerSec = bpm / 60;
    const boundaries = new Set<number>([0]);

    for (const cut of blueprint.sceneChanges) {
      // Snap to nearest bar boundary
      const rawBeat = cut.timestampSec * beatsPerSec;
      const barBeat = Math.round(rawBeat / timeSigN) * timeSigN;
      boundaries.add(barBeat);
    }

    return [...boundaries].sort((a, b) => a - b);
  }

  // ── Melody ─────────────────────────────────────────────────────────────────

  private generateMelodyTrack(
    table: MarkovTable,
    pitches: number[],
    profile: GenreProfile,
    totalBeats: number,
    sections: number[],
    intensityScale: number,
  ): InstrumentTrack {
    const notes: MIDINote[] = [];
    let currentPitch = pitches[Math.floor(this.rng() * pitches.length)];
    let beat = 0;

    while (beat < totalBeats) {
      // Rest probability — higher between sections
      const nearSection = sections.some(s => Math.abs(s - beat) < 1);
      if (this.rng() < (nearSection ? 0.4 : 0.15)) {
        const restLen = this.pickRandom(profile.noteDurations);
        beat += restLen;
        continue;
      }

      const duration = this.pickRandom(profile.noteDurations);
      const [vMin, vMax] = profile.velocityRange;
      const velocity = Math.round((vMin + this.rng() * (vMax - vMin)) * intensityScale);

      notes.push({
        pitch: Math.max(0, Math.min(127, currentPitch)),
        velocity: Math.max(1, Math.min(127, velocity)),
        startBeat: beat,
        durationBeats: duration,
      });

      currentPitch = markovNext(currentPitch, table, this.rng);
      beat += duration;

      // Occasional octave shift at section boundaries
      if (nearSection && this.rng() < 0.3) {
        const shift = this.rng() < 0.5 ? 12 : -12;
        const newPitch = currentPitch + shift;
        if (newPitch >= 36 && newPitch <= 96) currentPitch = newPitch;
      }
    }

    return {
      name: "melody",
      notes,
      defaultVolume: 0.8,
      channel: 0,
      program: profile.programs[0],
    };
  }

  // ── Bass ───────────────────────────────────────────────────────────────────

  private generateBassTrack(
    table: MarkovTable,
    pitches: number[],
    profile: GenreProfile,
    totalBeats: number,
    sections: number[],
    intensityScale: number,
  ): InstrumentTrack {
    const notes: MIDINote[] = [];
    let currentPitch = pitches[0]; // bass usually starts on root
    let beat = 0;

    while (beat < totalBeats) {
      const duration = this.pickRandom(profile.bassDurations);
      const [vMin, vMax] = profile.velocityRange;
      const velocity = Math.round((vMin + this.rng() * (vMax - vMin) * 0.7) * intensityScale);

      // At section boundaries occasionally jump to a different scale degree
      const nearSection = sections.some(s => Math.abs(s - beat) < 0.5);
      if (nearSection) {
        currentPitch = pitches[Math.floor(this.rng() * Math.min(4, pitches.length))];
      }

      notes.push({
        pitch: Math.max(0, Math.min(127, currentPitch)),
        velocity: Math.max(1, Math.min(127, velocity)),
        startBeat: beat,
        durationBeats: duration,
      });

      currentPitch = markovNext(currentPitch, table, this.rng);
      beat += duration;
    }

    return {
      name: "bass",
      notes,
      defaultVolume: 0.75,
      channel: 1,
      program: profile.programs[1],
    };
  }

  // ── Chords / pad ──────────────────────────────────────────────────────────

  private generateChordsTrack(
    pitches: number[],
    profile: GenreProfile,
    totalBeats: number,
    sections: number[],
    intensityScale: number,
  ): InstrumentTrack {
    const notes: MIDINote[] = [];
    const chordDur = profile.chordDuration;
    const [vMin, vMax] = profile.velocityRange;

    // Chord voicing: root, third, fifth from the scale
    const voicing = (rootIdx: number): number[] => {
      const ps = pitches;
      const len = ps.length;
      return [
        ps[rootIdx % len],
        ps[(rootIdx + 2) % len],
        ps[(rootIdx + 4) % len],
      ];
    };

    let beat = 0;
    let sectionIdx = 0;

    while (beat < totalBeats) {
      // Pick chord root from section index
      const degree = sectionIdx % 4 === 0 ? 0 :
                     sectionIdx % 4 === 1 ? 3 :
                     sectionIdx % 4 === 2 ? 4 : 2;
      const chord = voicing(degree);

      const velocity = Math.round((vMin * 0.8 + this.rng() * (vMax - vMin) * 0.6) * intensityScale);
      const dur = Math.min(chordDur, totalBeats - beat);

      for (const pitch of chord) {
        notes.push({
          pitch: Math.max(0, Math.min(127, pitch)),
          velocity: Math.max(1, Math.min(127, velocity)),
          startBeat: beat,
          durationBeats: dur,
        });
      }

      beat += chordDur;
      sectionIdx++;

      // Jump chord on section boundary
      if (sections.some(s => s > beat && s <= beat + chordDur)) {
        sectionIdx = (sectionIdx + 1) % 7;
      }
    }

    return {
      name: "chords",
      notes,
      defaultVolume: 0.6,
      channel: 2,
      program: profile.programs[2],
    };
  }

  // ── Percussion ─────────────────────────────────────────────────────────────

  private generatePercussionTrack(
    genre: Genre,
    profile: GenreProfile,
    totalBeats: number,
    timeSigN: number,
    intensityCurve: MusicBlueprint["intensityCurve"],
    bpm: number,
    intensityScale: number,
  ): InstrumentTrack {
    const notes: MIDINote[] = [];
    const patterns = DRUM_PATTERNS[genre];
    const beatsPerSec = bpm / 60;

    for (let bar = 0; bar * timeSigN < totalBeats; bar++) {
      const barStartBeat = bar * timeSigN;
      const barStartSec = barStartBeat / beatsPerSec;

      // Find intensity at this bar's start
      const closestCurve = intensityCurve.reduce(
        (prev, cur) =>
          Math.abs(cur.timestampSec - barStartSec) < Math.abs(prev.timestampSec - barStartSec)
            ? cur : prev,
        intensityCurve[0] ?? { timestampSec: 0, value: 0.5 },
      );
      const localIntensity = closestCurve.value * intensityScale;

      // Probabilistically skip quiet bars
      if (localIntensity < 0.2 && this.rng() < 0.6) continue;

      for (const pat of patterns) {
        for (const beatOffset of pat.beats) {
          const noteBeat = barStartBeat + beatOffset;
          if (noteBeat >= totalBeats) continue;

          // Add slight humanisation
          const humanOffset = (this.rng() - 0.5) * 0.04;
          const [vMin, vMax] = pat.velocityRange;
          const velocity = Math.round(
            (vMin + this.rng() * (vMax - vMin)) * localIntensity,
          );

          notes.push({
            pitch: pat.pitch,
            velocity: Math.max(1, Math.min(127, velocity)),
            startBeat: noteBeat + humanOffset,
            durationBeats: 0.125,
          });
        }
      }
    }

    // Sort by start beat
    notes.sort((a, b) => a.startBeat - b.startBeat);

    return {
      name: "percussion",
      notes,
      defaultVolume: 0.85,
      channel: 9, // MIDI percussion channel
      program: 0,
    };
  }

  // ── Regeneration helpers ──────────────────────────────────────────────────

  /**
   * Regenerate only the melody while keeping other tracks unchanged.
   * Useful for "regenerate melody" feature.
   */
  regenerateMelody(
    composition: MIDIComposition,
    blueprint: MusicBlueprint,
    opts: GeneratorOptions = {},
  ): MIDIComposition {
    const genre    = opts.genre       ?? composition.genre;
    const key      = opts.keyOverride ?? composition.key;
    const intensity = opts.intensityScale ?? 0.8;
    this.rng = this.seededRng(Date.now());

    const profile      = GENRE_PROFILES[genre];
    const { root }     = parseKey(key);
    const melodyPitches = buildScale(profile.scaleDegrees, root, 0);
    const melodyTable  = buildMarkovTable(melodyPitches, profile.transitionWeights);

    const newMelody = this.generateMelodyTrack(
      melodyTable, melodyPitches, profile,
      composition.totalBeats, composition.sectionBoundaries, intensity,
    );

    return {
      ...composition,
      tracks: composition.tracks.map(t => t.name === "melody" ? newMelody : t),
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private pickRandom<T>(items: T[]): T {
    return items[Math.floor(this.rng() * items.length)];
  }

  /** Mulberry32 seeded PRNG. */
  private seededRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

// ── Convenience singleton export ─────────────────────────────────────────────

export const melodyGenerator = new MelodyGenerator();
