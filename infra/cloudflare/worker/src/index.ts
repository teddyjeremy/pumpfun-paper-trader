import { DurableObject } from "cloudflare:workers";

interface Env {
  COORDINATOR: DurableObjectNamespace<PumpFunCoordinator>;
  HELIUS_API_KEY: string;
  PUMPFUN_PROGRAM_ID: string;
  CONTROL_TOKEN: string;
}

interface CoordinatorStatus {
  mode: "paper";
  connected: boolean;
  subscriptionConfirmed: boolean;
  enabled: boolean;
  tradingReady: false;
  blocker: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastSignature: string | null;
  notificationsSinceStart: number;
  lastError: string | null;
}

const INITIAL_STATUS: CoordinatorStatus = {
  mode: "paper",
  connected: false,
  subscriptionConfirmed: false,
  enabled: false,
  tradingReady: false,
  blocker: "Transaction decoding, strategy evaluation, executable quotes and ledger integration are not connected.",
  connectedAt: null,
  lastMessageAt: null,
  lastSignature: null,
  notificationsSinceStart: 0,
  lastError: null
};

export class PumpFunCoordinator extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private status: CoordinatorStatus = { ...INITIAL_STATUS };
  private hydrated = false;
  private connectingSinceMs = 0;

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const saved = await this.ctx.storage.get<CoordinatorStatus>("status");
    if (saved) this.status = { ...INITIAL_STATUS, ...saved };
    this.status.connected = false;
    this.hydrated = true;
  }

  async start(): Promise<CoordinatorStatus> {
    await this.hydrate();
    if (!this.env.HELIUS_API_KEY || !this.env.PUMPFUN_PROGRAM_ID) {
      throw new Error("HELIUS_API_KEY and PUMPFUN_PROGRAM_ID must be configured.");
    }
    await this.ctx.storage.put("enabled", true);
    this.status.enabled = true;
    this.connect();
    await this.persistStatus();
    return this.getStatus();
  }

  async stop(): Promise<CoordinatorStatus> {
    await this.hydrate();
    await this.ctx.storage.put("enabled", false);
    this.status.enabled = false;
    this.status.connected = false;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000, "Paper worker stopped");
    }
    await this.persistStatus();
    return this.getStatus();
  }

  async ensureRunning(): Promise<CoordinatorStatus> {
    await this.hydrate();
    const enabled = await this.ctx.storage.get<boolean>("enabled");
    this.status.enabled = enabled === true;

    if (!this.status.enabled) {
      if (this.socket) {
        const socket = this.socket;
        this.socket = null;
        socket.close(1000, "Paper worker disabled");
      }
      this.status.connected = false;
      await this.persistStatus();
      return this.getStatus();
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      await this.persistStatus();
      return this.getStatus();
    }

    if (
      this.socket?.readyState === WebSocket.CONNECTING &&
      Date.now() - this.connectingSinceMs < 30_000
    ) {
      await this.persistStatus();
      return this.getStatus();
    }

    if (this.socket?.readyState === WebSocket.CONNECTING) {
      const staleSocket = this.socket;
      this.socket = null;
      staleSocket.close(4000, "Connection attempt timed out");
    }

    if (!this.env.HELIUS_API_KEY || !this.env.PUMPFUN_PROGRAM_ID) {
      this.status.lastError = "Missing Helius or Pump.fun program configuration.";
      await this.persistStatus();
      return this.getStatus();
    }

    this.connect();
    await this.persistStatus();
    return this.getStatus();
  }

  async getStatus(): Promise<CoordinatorStatus> {
    await this.hydrate();
    return { ...this.status };
  }

  private connect(): void {
    if (this.socket) return;

    try {
      const endpoint = new URL("wss://mainnet.helius-rpc.com/");
      endpoint.searchParams.set("api-key", this.env.HELIUS_API_KEY);
      const socket = new WebSocket(endpoint.toString());
      this.socket = socket;
      this.connectingSinceMs = Date.now();

      socket.addEventListener("open", () => {
        this.status.connected = true;
        this.status.subscriptionConfirmed = false;
        this.status.connectedAt = new Date().toISOString();
        this.connectingSinceMs = 0;
        this.status.lastError = null;
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            { mentions: [this.env.PUMPFUN_PROGRAM_ID] },
            { commitment: "processed" }
          ]
        }));
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as {
            method?: string;
            params?: { result?: { value?: { signature?: string } } };
            id?: number;
            result?: number;
            error?: unknown;
          };
          if (message.id === 1 && message.error) {
            this.status.subscriptionConfirmed = false;
            this.status.lastError = "Helius rejected the logsSubscribe request.";
            return;
          }
          if (message.id === 1 && typeof message.result === "number") {
            this.status.subscriptionConfirmed = true;
          }
          if (message.method === "logsNotification") {
            this.status.notificationsSinceStart += 1;
            this.status.lastMessageAt = new Date().toISOString();
            this.status.lastSignature =
              message.params?.result?.value?.signature ?? this.status.lastSignature;
          }
        } catch {
          this.status.lastError = "Received a non-JSON Helius WebSocket message.";
        }
      });

      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.status.connected = false;
        this.status.subscriptionConfirmed = false;
        this.connectingSinceMs = 0;
      });

      socket.addEventListener("error", () => {
        this.status.lastError = "Helius WebSocket transport error.";
      });
    } catch {
      this.socket = null;
      this.status.connected = false;
      this.status.subscriptionConfirmed = false;
      this.connectingSinceMs = 0;
      this.status.lastError = "Unable to create the Helius WebSocket connection.";
    }
  }

  private async persistStatus(): Promise<void> {
    await this.ctx.storage.put("status", this.status);
  }
}

function authorized(request: Request, env: Env): boolean {
  return Boolean(env.CONTROL_TOKEN) && request.headers.get("authorization") === "Bearer " + env.CONTROL_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = env.COORDINATOR.idFromName("primary");
    const coordinator = env.COORDINATOR.get(id);

    if (url.pathname === "/health" && request.method === "GET") {
      const status = await coordinator.getStatus();
      return Response.json({
        service: "pumpfun-paper-worker",
        mode: "paper",
        ready: false,
        connected: status.connected,
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
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext
  ): Promise<void> {
    const id = env.COORDINATOR.idFromName("primary");
    const coordinator = env.COORDINATOR.get(id);
    context.waitUntil(coordinator.ensureRunning());
  }
};
