export const SESSION_STATE_VERSION = 1;

export type StoredClient = {
  clientId: string;
  label?: string | undefined;
  mode?: "managed" | "observe" | undefined;
  windowId?: number | undefined;
};

export type StoredLease = {
  clientId: string;
  desiredAttached: boolean;
  tabId: number;
};

export type SessionState = {
  clients: StoredClient[];
  generation: number;
  leases: StoredLease[];
  version: typeof SESSION_STATE_VERSION;
};

export function emptySessionState(): SessionState {
  return { clients: [], generation: 0, leases: [], version: SESSION_STATE_VERSION };
}

/** Browser storage is an external boundary; discard malformed rows instead of trusting casts. */
export function parseSessionState(value: unknown): SessionState {
  if (!isRecord(value) || value.version !== SESSION_STATE_VERSION) return emptySessionState();
  const clients = new Map<string, StoredClient>();
  for (const entry of Array.isArray(value.clients) ? value.clients : []) {
    const client = parseClient(entry);
    if (client) clients.set(client.clientId, client);
  }
  const leases = new Map<number, StoredLease>();
  for (const entry of Array.isArray(value.leases) ? value.leases : []) {
    const lease = parseLease(entry);
    if (lease) leases.set(lease.tabId, lease);
  }
  return {
    clients: [...clients.values()],
    generation: nonnegativeInteger(value.generation) ?? 0,
    leases: [...leases.values()],
    version: SESSION_STATE_VERSION,
  };
}

export function beginSessionGeneration(state: SessionState): SessionState {
  return { ...state, generation: state.generation + 1 };
}

/** Remove browser objects that no longer exist while retaining clients for broker reconnection. */
export function reconcileSessionState(
  state: SessionState,
  snapshot: { tabIds: Iterable<number>; windowIds: Iterable<number> },
): SessionState {
  const tabIds = new Set(snapshot.tabIds);
  const windowIds = new Set(snapshot.windowIds);
  return {
    ...state,
    clients: state.clients.map((client) =>
      client.windowId === undefined || windowIds.has(client.windowId)
        ? client
        : withoutWindow(client),
    ),
    leases: state.leases.filter((lease) => tabIds.has(lease.tabId)),
  };
}

export function findBootstrapTab(
  windows: Iterable<{ id?: unknown; tabs?: unknown }>,
  leasedTabIds: Iterable<number>,
): { tabId: number; windowId: number } | null {
  const leased = new Set(leasedTabIds);
  for (const window of windows) {
    const windowId = nonnegativeInteger(window.id);
    if (windowId === undefined || !Array.isArray(window.tabs)) continue;
    for (const tab of window.tabs) {
      if (!isRecord(tab)) continue;
      const tabId = nonnegativeInteger(tab.id);
      if (tabId !== undefined && tab.url === "about:blank" && !leased.has(tabId)) {
        return { tabId, windowId };
      }
    }
  }
  return null;
}

function parseClient(value: unknown): StoredClient | null {
  if (!isRecord(value) || typeof value.clientId !== "string" || value.clientId.length === 0) {
    return null;
  }
  const windowId = nonnegativeInteger(value.windowId);
  const label =
    typeof value.label === "string" && value.label.length > 0
      ? value.label.slice(0, 120)
      : undefined;
  const mode = value.mode === "managed" || value.mode === "observe" ? value.mode : undefined;
  return {
    clientId: value.clientId,
    ...(label === undefined ? {} : { label }),
    ...(mode === undefined ? {} : { mode }),
    ...(windowId === undefined ? {} : { windowId }),
  };
}

function parseLease(value: unknown): StoredLease | null {
  if (!isRecord(value) || typeof value.clientId !== "string" || value.clientId.length === 0) {
    return null;
  }
  const tabId = nonnegativeInteger(value.tabId);
  if (tabId === undefined || typeof value.desiredAttached !== "boolean") return null;
  return { clientId: value.clientId, desiredAttached: value.desiredAttached, tabId };
}

function withoutWindow(client: StoredClient): StoredClient {
  const { windowId: _windowId, ...rest } = client;
  return rest;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
