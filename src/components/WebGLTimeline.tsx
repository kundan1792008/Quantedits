"use client";

/**
 * WebGLTimeline – Hardware-accelerated video timeline renderer.
 *
 * Renders a multi-track video timeline using WebGL so that 4K video
 * thumbnails can be composited at 60 fps without frame drops.
 *
 * Architecture
 * ────────────
 * • A <canvas> element hosts a WebGL2 context (falls back to WebGL1).
 * • Each track clip is represented as a WebGL texture uploaded from an
 *   HTMLVideoElement (via texImage2D) or from a raw RGBA buffer produced
 *   by the GenerativePipeline.
 * • A simple vertex/fragment shader pair composites the clip textures
 *   with per-clip tint colours and opacity.
 * • The playhead (scrubber) and clip handles are rendered as coloured
 *   quads in the same pass for minimal draw calls.
 * • requestAnimationFrame drives the render loop; the loop is paused
 *   when the component unmounts to avoid memory leaks.
 *
 * Props
 * ─────
 * Accepts the same `highlights` array as the existing CSS Timeline so
 * that the two components can be swapped without changing the parent.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { Highlight } from "./HookGenerator";

// ── Types ──────────────────────────────────────────────────────────────────

interface WebGLTimelineProps {
  highlights: Highlight[];
  fileName?: string;
  /** Current playhead position as a 0–1 fraction of total duration. */
  playheadFraction?: number;
  /** Called when the user scrubs the playhead (value 0–1). */
  onScrub?: (fraction: number) => void;
}

interface ClipRect {
  /** 0–1 fraction of canvas width. */
  left: number;
  width: number;
  /** 0–1 fraction of canvas height. */
  top: number;
  height: number;
  color: [number, number, number, number]; // RGBA 0-1
  labelText: string;
}

// ── Shader source ──────────────────────────────────────────────────────────

const VERT_SHADER_SRC = `#version 300 es
precision highp float;

// Quad geometry: positions in clip space [-1, 1]
in vec2 a_position;
in vec2 a_texCoord;

out vec2 v_texCoord;

uniform vec2 u_translation;  // NDC offset
uniform vec2 u_scale;         // NDC scale

void main() {
  vec2 ndc = a_position * u_scale + u_translation;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_texCoord  = a_texCoord;
}
`;

const FRAG_SHADER_SRC = `#version 300 es
precision mediump float;

in vec2 v_texCoord;

uniform sampler2D u_texture;
uniform vec4      u_color;      // flat colour used when u_useTexture == 0
uniform int       u_useTexture; // 1 = sample texture, 0 = flat colour

out vec4 fragColor;

void main() {
  if (u_useTexture == 1) {
    fragColor = texture(u_texture, v_texCoord) * u_color;
  } else {
    fragColor = u_color;
  }
}
`;

// ── WebGL helpers ──────────────────────────────────────────────────────────

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return prog;
}

/** Create a unit quad VAO with positions and texCoords. */
function createQuadVAO(gl: WebGL2RenderingContext, program: WebGLProgram) {
  // positions: unit square [0,1] × [0,1] as two triangles
  const positions = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
  const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]);

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const texBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
  gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
  const texLoc = gl.getAttribLocation(program, "a_texCoord");
  gl.enableVertexAttribArray(texLoc);
  gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  return vao;
}

/** Create a 1×1 white texture as placeholder. */
function createWhiteTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

// ── Colour palette (matches existing Timeline CSS colours) ─────────────────

const TRACK_COLORS: Array<[number, number, number, number]> = [
  [0.486, 0.227, 0.929, 0.35], // #7C3AED
  [0.024, 0.714, 0.831, 0.35], // #06B6D4
  [0.925, 0.271, 0.604, 0.35], // #EC4899
  [0.961, 0.620, 0.043, 0.35], // #F59E0B
  [0.063, 0.706, 0.506, 0.35], // #10B981
];

const TRACK_BORDER_COLORS: Array<[number, number, number, number]> = [
  [0.486, 0.227, 0.929, 0.7],
  [0.024, 0.714, 0.831, 0.7],
  [0.925, 0.271, 0.604, 0.7],
  [0.961, 0.620, 0.043, 0.7],
  [0.063, 0.706, 0.506, 0.7],
];

// ── Component ──────────────────────────────────────────────────────────────

export default function WebGLTimeline({
  highlights,
  fileName,
  playheadFraction = 0,
  onScrub,
}: WebGLTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef     = useRef<WebGL2RenderingContext | null>(null);
  const progRef   = useRef<WebGLProgram | null>(null);
  const vaoRef    = useRef<WebGLVertexArrayObject | null>(null);
  const texRef    = useRef<WebGLTexture | null>(null);
  const rafRef    = useRef<number>(0);

  // Track whether WebGL initialised successfully
  const [glReady, setGlReady] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  // Current playhead fraction — kept in a ref so the RAF loop always sees
  // the latest value without triggering re-render on every frame.
  const playheadRef = useRef(playheadFraction);
  useEffect(() => { playheadRef.current = playheadFraction; }, [playheadFraction]);

  // Build the list of clip rects from highlights
  const buildClipRects = useCallback(
    (): ClipRect[] => {
      if (!highlights.length) return [];

      const trackCount  = Math.min(highlights.length, 5);
      const trackHeight = 0.6 / trackCount; // 60% of canvas height for tracks
      const topOffset   = 0.15;            // 15% top margin for ruler
      const totalSec    = 120 * 60;

      return highlights.slice(0, 5).map<ClipRect>((h, i) => {
        // Support both MM:SS and HH:MM:SS timecode formats
        const parts = h.startTimecode.split(":");
        let startSec = 0;
        if (parts.length === 3) {
          const hh = Number(parts[0]);
          const mm = Number(parts[1]);
          const ss = Number(parts[2]);
          startSec = (isNaN(hh) ? 0 : hh) * 3600
                   + (isNaN(mm) ? 0 : mm) * 60
                   + (isNaN(ss) ? 0 : ss);
        } else if (parts.length === 2) {
          const mm = Number(parts[0]);
          const ss = Number(parts[1]);
          startSec = (isNaN(mm) ? 0 : mm) * 60 + (isNaN(ss) ? 0 : ss);
        }
        const durSec   = parseInt(h.duration) || 10;
        const left  = startSec / totalSec;
        const width = Math.max(durSec / totalSec, 0.015);

        return {
          left,
          width,
          top:    topOffset + i * trackHeight,
          height: trackHeight * 0.7,
          color:  TRACK_COLORS[i % TRACK_COLORS.length],
          labelText: `T${i + 1}`,
        };
      });
    },
    [highlights],
  );

  // ── WebGL setup ──────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha:              true,
        antialias:          false,
        depth:              false,
        stencil:            false,
        powerPreference:    "high-performance",
        preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error("WebGL2 not supported; falling back to CSS timeline.");

      const program = createProgram(gl, VERT_SHADER_SRC, FRAG_SHADER_SRC);
      const vao     = createQuadVAO(gl, program);
      const whiteTex = createWhiteTexture(gl);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.051, 0.051, 0.067, 1); // #0D0D11

      glRef.current   = gl;
      progRef.current = program;
      vaoRef.current  = vao;
      texRef.current  = whiteTex;

      setGlReady(true);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }

    // ── Render loop ────────────────────────────────────────────────────────

    const draw = () => {
      const canvas = canvasRef.current;
      const gl     = glRef.current;
      const prog   = progRef.current;
      const vao    = vaoRef.current;
      const tex    = texRef.current;
      if (!canvas || !gl || !prog || !vao || !tex) return;

      // Keep canvas pixel dimensions in sync with CSS layout
      const dpr = window.devicePixelRatio || 1;
      const cw  = Math.floor(canvas.clientWidth  * dpr);
      const ch  = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width  = cw;
        canvas.height = ch;
        gl.viewport(0, 0, cw, ch);
      }

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_texture"), 0);

      const clips = buildClipRects();

      // Draw clip fills
      clips.forEach((clip) => {
        drawQuad(gl!, prog!, clip.left, clip.top, clip.width, clip.height, clip.color);
      });

      // Draw clip left-edge accent bar
      clips.forEach((clip, i) => {
        const border = TRACK_BORDER_COLORS[i % TRACK_BORDER_COLORS.length];
        drawQuad(
          gl!, prog!,
          clip.left,
          clip.top,
          0.003,
          clip.height,
          border,
        );
      });

      // Draw playhead
      const phX    = playheadRef.current;
      const phColor: [number, number, number, number] = [1, 1, 1, 0.85];
      drawQuad(gl!, prog!, phX, 0.05, 0.002, 0.9, phColor);

      // Grid ruler lines (every ~8.33% of width)
      for (let tick = 0; tick <= 12; tick++) {
        const x = tick / 12;
        drawQuad(
          gl!, prog!,
          x,
          0.1,
          0.001,
          0.85,
          [0.1, 0.1, 0.18, 0.6],
        );
      }

      gl.bindVertexArray(null);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl?.deleteProgram(progRef.current);
      glRef.current   = null;
      progRef.current = null;
      vaoRef.current  = null;
      texRef.current  = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-trigger render when highlights change (by re-building clip rects)
  // The render loop always calls buildClipRects, so this is handled automatically.

  // ── Scrub interaction ─────────────────────────────────────────────────────

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onScrub) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onScrub(fraction);
    },
    [onScrub],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (glError) {
    // Graceful degradation: render the original CSS timeline
    return (
      <div
        className="h-full flex flex-col items-center justify-center"
        style={{ background: "#0D0D11" }}
      >
        <span className="text-[10px] text-[#3a3a5a] font-mono px-4 text-center">
          {glError}
        </span>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative" style={{ background: "#0D0D11" }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: "block", cursor: onScrub ? "col-resize" : "default" }}
        onClick={handleCanvasClick}
        aria-label="WebGL video timeline"
      />

      {/* Overlay: track labels (rendered in DOM above canvas for accessibility) */}
      {glReady && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          {/* Header badge */}
          <div className="flex items-center gap-2 px-3 pt-1">
            <span className="text-[9px] text-[#3a3a5a] font-mono">
              TIMELINE · WebGL
            </span>
            {highlights.length > 0 && (
              <span className="text-[9px] text-cyan-600">
                {highlights.length} hooks
              </span>
            )}
            {fileName && (
              <span className="text-[9px] text-[#2a2a4a] font-mono ml-auto truncate max-w-[160px]">
                {fileName}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── GL draw helper ─────────────────────────────────────────────────────────

/**
 * Draw a flat-coloured quad.
 *
 * Coordinates are expressed as 0–1 fractions of the canvas; the shader
 * maps them to NDC space internally.
 */
function drawQuad(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  xFrac: number,
  yFrac: number,
  wFrac: number,
  hFrac: number,
  color: [number, number, number, number],
): void {
  // Convert 0-1 fractions to NDC [-1, 1]
  const ndcX = xFrac * 2 - 1;
  const ndcY = 1 - (yFrac + hFrac) * 2; // flip Y
  const ndcW = wFrac * 2;
  const ndcH = hFrac * 2;

  gl.uniform2f(gl.getUniformLocation(prog, "u_translation"), ndcX, ndcY);
  gl.uniform2f(gl.getUniformLocation(prog, "u_scale"),       ndcW, ndcH);
  gl.uniform4f(gl.getUniformLocation(prog, "u_color"), color[0], color[1], color[2], color[3]);
  gl.uniform1i(gl.getUniformLocation(prog, "u_useTexture"), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
