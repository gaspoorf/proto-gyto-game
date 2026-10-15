// Central tuning file. Every value here can also be edited live from the
// "Réglages" panel (lil-gui); changes are persisted in localStorage.

export interface ToolParams {
  /** Jet footprint radius on the surface, in metres. */
  radius: number;
  /** Coverage added per second at full intensity. */
  rate: number;
  /** Intensity multiplier at the centre of the footprint. */
  center: number;
  /** Intensity multiplier at the edge of the footprint. */
  edge: number;
}

export type Quality = 'low' | 'medium' | 'high';

/** Gyroscope gun (ESP32 over Web Serial). */
export interface GunSettings {
  yawAxis: 'x' | 'y' | 'z';
  invertYaw: boolean;
  pitchAxis: 'x' | 'y' | 'z';
  invertPitch: boolean;
  sensitivity: number;
  /** Gun rotation (degrees) needed to reach the left/right edge. */
  maxYaw: number;
  /** Gun rotation (degrees) needed to reach the top/bottom edge. */
  maxPitch: number;
  /** Angular speed (rad/s) ignored to limit drift. */
  deadzone: number;
  /** Reticle smoothing (0 = raw, 0.9 = very smooth). */
  smoothing: number;
}

export interface Settings {
  paint: ToolParams;
  /** Irregularity of paint splat outlines (0 = round). */
  paintIrregularity: number;
  /** Round length in seconds. */
  matchDuration: number;
  /** Coverage (%) to reach before time runs out. */
  goal: number;
  reducedFx: boolean;
  drips: boolean;
  muted: boolean;
  volume: number;
  quality: Quality;
  gun: GunSettings;
}

export const DEFAULTS: Settings = {
  paint: { radius: 0.27, rate: 7.5, center: 1.0, edge: 0.45 },
  paintIrregularity: 0.22,
  matchDuration: 60,
  goal: 70,
  reducedFx: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  drips: true,
  muted: false,
  volume: 0.8,
  quality: 'high',
  gun: {
    yawAxis: 'x',
    invertYaw: true,
    pitchAxis: 'y',
    invertPitch: true,
    sensitivity: 1,
    maxYaw: 30,
    maxPitch: 20,
    deadzone: 0.02,
    smoothing: 0.4,
  },
};

export interface QualityPreset {
  /** Paint mask texels per metre. Higher = crisper edges, more memory. */
  texelDensity: number;
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
  /** AO bake sample spacing in texels. */
  aoStride: number;
  aoRays: number;
  particleScale: number;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  low: { texelDensity: 40, pixelRatioCap: 1, shadows: false, shadowMapSize: 1024, aoStride: 3, aoRays: 8, particleScale: 0.5 },
  medium: { texelDensity: 52, pixelRatioCap: 1.5, shadows: true, shadowMapSize: 1024, aoStride: 3, aoRays: 10, particleScale: 0.8 },
  high: { texelDensity: 64, pixelRatioCap: 2, shadows: true, shadowMapSize: 2048, aoStride: 4, aoRays: 12, particleScale: 1 },
};

export const COLORS = {
  paint: 0xff2d95,
  paintCss: '#ff2d95',
  clay: 0xf4f2ef,
  background: 0xe9e7e3,
};

/** Fixed simulation rate: deposits, cleaning and the timer are frame-rate independent. */
export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

/** Coverage → painted ramp used by the score. Matches the visual threshold of the shader (≈0.5 ± noise). */
export const DIRTY_RAMP_LO = 0.3;
export const DIRTY_RAMP_HI = 0.7;

const STORAGE_KEY = 'pittymi.settings.v3';

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (typeof cur === 'object' && cur !== null) out[k] = deepMerge(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out;
}

function load(): Settings {
  const base: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deepMerge(base, JSON.parse(raw));
  } catch {
    /* storage unavailable: keep defaults */
  }
  return base;
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function resetBalance(): void {
  settings.paint = { ...DEFAULTS.paint };
  settings.paintIrregularity = DEFAULTS.paintIrregularity;
  settings.matchDuration = DEFAULTS.matchDuration;
  settings.goal = DEFAULTS.goal;
  saveSettings();
}

export function resetGun(): void {
  Object.assign(settings.gun, DEFAULTS.gun);
  saveSettings();
}
