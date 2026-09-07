import { QueryClient, QueryFunction } from "@tanstack/react-query";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// A 401 mid-session means the server no longer honours our cookie: redeploys
// AND routine Fly machine restarts wipe the in-memory session store while the
// 30-day cookie lives on. AuthGate's status probe is cached forever (staleTime
// Infinity), so without this every page would just error away with no path
// back to the login screen — on a phone Home-Screen tab there is no reload
// button to escape with. Re-probing flips /api/auth/status (pre-gate, never
// itself a 401) to authed:false and AuthGate swaps the login screen back in.
// Exported so any fetch path outside apiRequest can share the hook.
// Throttled: a burst of parallel 401s (every query on a page failing at once)
// needs ONE re-probe, not one per failure — and the throttle also caps any
// hypothetical invalidate→refetch→401 feedback to once a second.
let lastUnauthorizedProbe = 0;
export function onSessionUnauthorized() {
  const now = Date.now();
  if (now - lastUnauthorizedProbe < 1000) return;
  lastUnauthorizedProbe = now;
  queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
}

/** `"400: {\"error\":\"…\"}"` → the …, so a refusal reads in the server's own
 *  words rather than as an HTTP status glued to a JSON blob. Anything
 *  unparseable passes through verbatim. Shared: every surface that shows an
 *  API failure to the owner routes through this, so none of them can drift
 *  back to dumping the raw envelope. */
export function apiErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const body = raw.replace(/^\d+:\s*/, "");
  try { return String(JSON.parse(body).error ?? body); } catch { return body; }
}

/** True when the error is a real HTTP refusal (the server answered and said
 *  no), false for a transport failure ("fetch failed", a timeout, an aborted
 *  connection). The two need different words: only the first was "refused". */
export function isHttpRefusal(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /^\d+:/.test(raw);
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) onSessionUnauthorized();
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (res.status === 401 && !String(queryKey[0]).includes("/api/auth/status")) {
      onSessionUnauthorized();
    }
    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
