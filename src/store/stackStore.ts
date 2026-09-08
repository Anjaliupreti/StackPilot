import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ApprovalRequest,
  AuditEvent,
  Stack,
  StackPilotConfig,
} from "../core/types.js";

interface StoreShape {
  config?: StackPilotConfig;
  stacks: Stack[];
  audit: AuditEvent[];
  approvals: ApprovalRequest[];
}

const EMPTY: StoreShape = { stacks: [], audit: [], approvals: [] };

/**
 * File-backed store for StackPilot state. Everything lives under `.stackpilot/`
 * so the stack model, config, pending approvals, and the append-only audit log
 * survive across CLI invocations.
 */
export class StackStore {
  private data: StoreShape = EMPTY;
  private readonly file: string;

  constructor(root: string = process.cwd()) {
    this.file = join(root, ".stackpilot", "state.json");
  }

  get path(): string {
    return this.file;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) {
      this.data = structuredClone(EMPTY);
      return;
    }
    const raw = await readFile(this.file, "utf8");
    this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  // ---- config -----------------------------------------------------------
  getConfig(): StackPilotConfig | undefined {
    return this.data.config;
  }

  async setConfig(config: StackPilotConfig): Promise<void> {
    this.data.config = config;
    await this.persist();
  }

  // ---- stacks -----------------------------------------------------------
  listStacks(): Stack[] {
    return this.data.stacks;
  }

  getStack(idOrName: string): Stack | undefined {
    return this.data.stacks.find(
      (s) => s.id === idOrName || s.name === idOrName
    );
  }

  async saveStack(stack: Stack): Promise<void> {
    const idx = this.data.stacks.findIndex((s) => s.id === stack.id);
    stack.updatedAt = new Date().toISOString();
    if (idx >= 0) this.data.stacks[idx] = stack;
    else this.data.stacks.push(stack);
    await this.persist();
  }

  // ---- audit ------------------------------------------------------------
  async appendAudit(
    event: Omit<AuditEvent, "id" | "timestamp">
  ): Promise<AuditEvent> {
    const full: AuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.data.audit.push(full);
    await this.persist();
    return full;
  }

  getAudit(stackId?: string): AuditEvent[] {
    return stackId
      ? this.data.audit.filter((e) => e.stackId === stackId)
      : this.data.audit;
  }

  // ---- approvals --------------------------------------------------------
  async saveApproval(req: ApprovalRequest): Promise<void> {
    const idx = this.data.approvals.findIndex((a) => a.id === req.id);
    if (idx >= 0) this.data.approvals[idx] = req;
    else this.data.approvals.push(req);
    await this.persist();
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.data.approvals.find((a) => a.id === id);
  }

  listApprovals(status?: ApprovalRequest["status"]): ApprovalRequest[] {
    return status
      ? this.data.approvals.filter((a) => a.status === status)
      : this.data.approvals;
  }
}
