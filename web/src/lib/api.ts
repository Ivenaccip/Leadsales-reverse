const WS_KEY = 'leadlibre.workspace';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function getWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}

export function setWorkspaceId(id: string | null) {
  try {
    if (id) localStorage.setItem(WS_KEY, id);
    else localStorage.removeItem(WS_KEY);
  } catch {
    /* storage unavailable */
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const ws = getWorkspaceId();
  if (ws) headers['X-Workspace-Id'] = ws;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { ...init, method, headers, body: payload, credentials: 'include' });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as any)?.error ?? {};
    if (res.status === 401 && onUnauthorized && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? `Error ${res.status}`, err.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  upload: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request<{ media: { id: string; mime: string; size: number; filename: string | null } }>('POST', '/api/media', fd);
  },
};

/** Query string helper that skips empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    s.set(k, String(v === true ? 1 : v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

export function mediaUrl(id: string): string {
  return `/api/media/${id}?ws=${encodeURIComponent(getWorkspaceId() ?? '')}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Ocurrió un error inesperado';
}
