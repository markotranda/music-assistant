import { useUiStore } from "../stores/ui";

/** Thin typed fetch client. The API token (if any) rides along automatically. */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useUiStore.getState().token;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiRequestError(res.status, (body.error as string) ?? `HTTP ${res.status}`, body);
  }
  return body as T;
}

export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) });
}

export function apiPut<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "PUT", body: JSON.stringify(data) });
}

export function apiPatch<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}

export function apiDelete<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
