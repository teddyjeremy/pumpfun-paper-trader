import { DurableObject } from "cloudflare:workers";
import {
  applyDiscoveryEvent,
  emptyDiscoveryStore,
  type DiscoveryStoreState
} from "../../../../src/ingestion/discovery-store.js";
import {
  buildPumpPortalDiscoveryUrl,
  parsePumpPortalDiscoveryMessage,
  pumpPortalDiscoverySubscriptions
} from "../../../../src/ingestion/pumpportal.js";

interface Env {
  COORDINATOR: DurableObjectNamespace<PumpFunCoordinator>;
  CONTROL_TOKEN: string;
}

interface CoordinatorStatus {
  mode: "paper";
  provider: "pumpportal";
  connected: boolean;
  subscriptionsSent: boolean;
  enabled: boolean;
  tradingReady: false;
  blocker: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastSignature: string | null;
  notificationsSinceStart: number;
  candidates: number;
  acceptedCandidates: number;
  duplicateEvents: number;
  migrations: number;
  overflowEvents: number;
  incompleteEvents: number;
  lastPersistedAt: string | null;
  lastError: string | null;
}

const INITIAL_STATUS: CoordinatorStatus = {
  mode: "paper",
  provider: "pumpportal",
  connected: false,
  subscriptionsSent: false,
  enabled: false,
  tradingReady: false,
  blocker: "On-chain verification, selective Helius monitoring, strategy evaluation, executable quotes and paper ledger are not connected.",
  connectedAt: null,
  lastMessageAt: null,
  lastSignature: null,
  notificationsSinceStart: 0,
  candidates: 0,
  acceptedCandidates: 0,
  duplicateEvents: 0,
  migrations: 0,
  overflowEvents: 0,
  incompleteEvents: 0,
  lastPersistedAt: null,
  lastError: null
};

const MAX_CANDIDATES = 100;
const PERSIST_EVERY_EVENTS = 25;

export class PumpFunCoordinator extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private status: CoordinatorStatus = { ...INITIAL_STATUS };
  private discovery: DiscoveryStoreState = emptyDiscoveryStore();
  private hydrated = false;
  private pendingWrites = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private connectingSinceMs = 0;

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const [savedStatus, savedDiscovery, enabled] = await Promise.all([
      this.ctx.storage.get<CoordinatorStatus>("status"),
      this.ctx.storage.get<DiscoveryStoreState>("discovery_state"),
      this.ctx.storage.get<boolean>("enabled")
    ]);
    if (savedStatus) this.status = { ...INITIAL_STATUS, ...savedStatus };
    if (savedDiscovery) this.discovery = savedDiscovery;
    this.status.enabled = enabled === true;
    // Outbound sockets cannot survive a Durable Object restart.
    this.status.connected = false;
    this.status.subscriptionsSent = false;
    this.syncCounts();
    this.hydrated = true;
  }

  async start(): Promise<CoordinatorStatus> {
    await this.hydrate();
    await this.ctx.storage.put("enabled", true);
    this.status.enabled = true;
    this.connect();
    await this.persist();
    return this.getStatus();
  }

  async stop(): Promise<CoordinatorStatus> {
    await this.hydrate();
    await this.ctx.storage.put("enabled", false);
    this.status.enabled = false;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000, "Paper discovery stopped");
    }
    this.status.connected = false;
    this.status.subscriptionsSent = false;
    await this.persist();
    return this.getStatus();
  }

  async ensureRunning(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (!this.status.enabled) {
      if (this.socket) {
        const socket = this.socket;
        this.socket = null;
        socket.close(1000, "Paper discovery disabled");
      }
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      await this.persist();
      return this.getStatus();
    }

    // Flush the bounded in-memory batch at least once per cron interval.
    await this.persist();

    if (this.socket?.readyState === WebSocket.OPEN) {
      const connectedAtMs = this.status.connectedAt ? Date.parse(this.status.connectedAt) : 0;
      if (connectedAtMs > 0 && Date.now() - connectedAtMs < 14 * 60 * 1000) {
        return this.getStatus();
      }
      const oldSocket = this.socket;
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      oldSocket.close(4001, "Scheduled connection rotation");
    }

    if (this.socket?.readyState === WebSocket.CONNECTING &&
        Date.now() - this.connectingSinceMs < 30_000) {
      return this.getStatus();
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      const oldSocket = this.socket;
      this.socket = null;
      oldSocket.close(4000, "Connection attempt timed out");
    }

    this.connect();
    await this.persist();
    return this.getStatus();
  }

  async getStatus(): Promise<CoordinatorStatus> {
    await this.hydrate();
    this.syncCounts();
    return { ...this.status };
  }

  async listCandidates(): Promise<DiscoveryStoreState> {
    await this.hydrate();
    return structuredClone(this.discovery);
  }

  private connect(): void {
    if (this.socket) return;
    try {
      const socket = new WebSocket(buildPumpPortalDiscoveryUrl());
      this.socket = socket;
      this.connectingSinceMs = Date.now();

      socket.addEventListener("open", () => {
        if (this.socket !== socket || !this.status.enabled) {
          socket.close(1000, "Coordinator disabled before connection opened");
          return;
        }
        this.status.connected = true;
        this.status.subscriptionsSent = false;
        this.status.connectedAt = new Date().toISOString();
        this.connectingSinceMs = 0;
        this.status.lastError = null;
        for (const subscription of pumpPortalDiscoverySubscriptions()) {
          socket.send(JSON.stringify(subscription));
        }
        this.status.subscriptionsSent = true;
      });

      socket.addEventListener("message", (message: MessageEvent) => {
        if (this.socket !== socket || !this.status.enabled) return;
        this.status.notificationsSinceStart += 1;
        this.status.lastMessageAt = new Date().toISOString();
        const parsed = parsePumpPortalDiscoveryMessage(
          typeof message.data === "string" ? message.data : null,
          this.status.lastMessageAt
        );
        if (parsed.status === "IGNORED") return;
        if (parsed.status === "DATA_INCOMPLETE") {
          this.discovery.incomplete += 1;
          this.pendingWrites += 1;
          this.syncCounts();
          if (this.pendingWrites >= PERSIST_EVERY_EVENTS) void this.persist().catch(() => undefined);
          return;
        }

        this.status.lastSignature = parsed.event.signature ?? this.status.lastSignature;
        const result = applyDiscoveryEvent(this.discovery, {
          kind: parsed.event.kind,
          mint: parsed.event.mint,
          signature: parsed.event.signature,
          creator: parsed.event.creator,
          bondingCurve: parsed.event.bondingCurve,
          name: parsed.event.name,
          symbol: parsed.event.symbol,
          receivedAt: parsed.event.receivedAt
        }, { cap: MAX_CANDIDATES, now: this.status.lastMessageAt });
        this.discovery = result.state;
        this.pendingWrites += 1;
        this.syncCounts();
        if (this.pendingWrites >= PERSIST_EVERY_EVENTS) void this.persist();
      });

      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.status.connected = false;
        this.status.subscriptionsSent = false;
        this.status.connectedAt = null;
        this.connectingSinceMs = 0;
        void this.persist();
      });

      socket.addEventListener("error", () => {
        if (this.socket !== socket || !this.status.enabled) return;
        this.status.lastError = "PumpPortal WebSocket transport error.";
        void this.persist();
      });
    } catch {
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionsSent = false;
      this.connectingSinceMs = 0;
      this.status.lastError = "Unable to create the PumpPortal WebSocket connection.";
    }
  }

  private syncCounts(): void {
    this.status.candidates = this.discovery.candidates.length;
    this.status.acceptedCandidates = this.discovery.accepted;
    this.status.duplicateEvents = this.discovery.duplicates;
    this.status.migrations = this.discovery.migrations;
    this.status.overflowEvents = this.discovery.overflow;
    this.status.incompleteEvents = this.discovery.incomplete;
    this.status.lastPersistedAt = this.discovery.lastPersistedAt;
  }

  private async persist(): Promise<void> {
    const pendingAtStart = this.pendingWrites;
    this.pendingWrites = 0;
    const snapshot = structuredClone(this.discovery);
    snapshot.lastPersistedAt = new Date().toISOString();
    this.discovery.lastPersistedAt = snapshot.lastPersistedAt;
    this.syncCounts();
    const statusSnapshot = { ...this.status };
    const write = this.persistChain.then(() => this.ctx.storage.put({
      status: statusSnapshot,
      discovery_state: snapshot
    }));
    this.persistChain = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.pendingWrites += pendingAtStart;
      this.status.lastError = "Unable to persist discovery state; ingestion may be incomplete.";
      throw error;
    }
  }
}

function authorized(request: Request, env: Env): boolean {
  return Boolean(env.CONTROL_TOKEN) &&
    request.headers.get("authorization") === "Bearer " + env.CONTROL_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("primary"));

    if (url.pathname === "/health" && request.method === "GET") {
      const status = await coordinator.getStatus();
      return Response.json({
        service: "pumpfun-paper-worker",
        mode: "paper",
        ready: false,
        provider: "pumpportal",
        connected: status.connected,
        candidates: status.candidates,
        blocker: status.blocker
      });
    }

    if (!authorized(request, env)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/start" && request.method === "POST") {
      return Response.json(await coordinator.start());
    }
    if (url.pathname === "/stop" && request.method === "POST") {
      return Response.json(await coordinator.stop());
    }
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json(await coordinator.getStatus());
    }
    if (url.pathname === "/candidates" && request.method === "GET") {
      return Response.json(await coordinator.listCandidates());
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext
  ): Promise<void> {
    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("primary"));
    context.waitUntil(coordinator.ensureRunning());
  }
};
