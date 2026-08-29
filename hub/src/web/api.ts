export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Camera {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  ip: string | null;
  rssi: number | null;
  fwVersion: string | null;
  sd: { mounted: boolean; totalKb: number; usedKb: number };
  viewers: number;
}

export interface CameraSettings {
  framesize: number;
  quality: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hmirror: number;
  vflip: number;
  flash: number;
}

export interface CameraInfo {
  deviceId: string;
  name: string;
  fwVersion: string;
  uptimeMs: number;
  ip: string;
  rssi: number;
  psram: boolean;
  heapFree: number;
  sd: { mounted: boolean; totalKb: number; usedKb: number };
  settings: CameraSettings;
}

export interface SdEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface SdListing {
  path: string;
  entries: SdEntry[];
  truncated: boolean;
}

export interface PairingCode {
  code: string;
  display: string;
  expiresAt: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      // Required by the hub on every state-changing call; see app.ts CSRF note.
      'X-Requested-With': 'esp32camchecker',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Session expired or never existed. Every view can then stay ignorant of
      // auth: the shell listens for this and swaps in the login screen.
      window.dispatchEvent(new CustomEvent('hub:unauthorized'));
    }
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  me: () => request<{ username: string | null }>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<{ username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  cameras: () => request<{ cameras: Camera[] }>('/api/cameras'),

  cameraInfo: (id: string) => request<CameraInfo>(`/api/cameras/${encodeURIComponent(id)}/info`),

  rename: (id: string, name: string) =>
    request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  settings: (id: string, patch: Partial<Record<keyof CameraSettings, number>>) =>
    request<{ applied: number; settings: CameraSettings }>(
      `/api/cameras/${encodeURIComponent(id)}/settings`,
      { method: 'POST', body: JSON.stringify(patch) },
    ),

  capture: (id: string) =>
    request<{ path: string }>(`/api/cameras/${encodeURIComponent(id)}/capture`, {
      method: 'POST',
    }),

  reboot: (id: string) =>
    request<{ rebooting: boolean }>(`/api/cameras/${encodeURIComponent(id)}/reboot`, {
      method: 'POST',
    }),

  sdList: (id: string, path: string) =>
    request<SdListing>(
      `/api/cameras/${encodeURIComponent(id)}/sd?path=${encodeURIComponent(path)}`,
    ),

  sdDelete: (id: string, path: string) =>
    request<{ deleted: boolean }>(
      `/api/cameras/${encodeURIComponent(id)}/sd/file?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),

  newPairingCode: () => request<PairingCode>('/api/pair/code', { method: 'POST' }),
};

export function streamSrc(id: string): string {
  return `/api/cameras/${encodeURIComponent(id)}/stream`;
}

export function snapshotSrc(id: string): string {
  return `/api/cameras/${encodeURIComponent(id)}/snapshot?t=${Date.now()}`;
}

export function fileSrc(id: string, path: string, download = false): string {
  const base = `/api/cameras/${encodeURIComponent(id)}/sd/file?path=${encodeURIComponent(path)}`;
  return download ? `${base}&download=1` : base;
}
