export const DEFAULT_PUBLIC_ORIGIN = "https://arbmone.api.br";

type EnvMap = Record<string, string | undefined>;
const viteEnv = ((import.meta as ImportMeta & { env?: EnvMap }).env ?? {}) as EnvMap;
const nodeEnv = (typeof process !== "undefined" ? process.env : {}) as EnvMap;
const env: EnvMap = { ...nodeEnv, ...viteEnv };

function normalizeOrigin(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_PUBLIC_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return DEFAULT_PUBLIC_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

export const PUBLIC_ORIGIN = normalizeOrigin(env.VITE_PUBLIC_ORIGIN);
export const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
export const COMMERCIAL_DISTRIBUTOR = String(
  env.VITE_COMMERCIAL_DISTRIBUTOR ?? "ZEVANORY",
).trim() || "ZEVANORY";
