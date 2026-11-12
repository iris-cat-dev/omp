import type { SessionInboundMessage, SessionOutboundMessage } from "@omp-desktop/protocol/messages";

import type { Logger } from "pino";
import { OmpPluginCliService } from "./omp-plugin-cli-service.js";

/**
 * Routes `ompPlugins.*` session messages to the CLI-backed service.
 * Kept separate from the daemon plugin runtime (`plugin.*` messages) on
 * purpose: the OMP CLI plugin ecosystem has its own lifecycle and state.
 */
export class OmpPluginSession {
  private readonly service: OmpPluginCliService;
  private readonly emitFn: (msg: SessionOutboundMessage) => void;
  private readonly logger: Logger;

  constructor(options: {
    service: OmpPluginCliService;
    emit: (msg: SessionOutboundMessage) => void;
    logger: Logger;
  }) {
    this.service = options.service;
    this.emitFn = options.emit;
    this.logger = options.logger.child({ module: "omp-plugin-session" });
  }

  handleInboundMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "ompPlugins.management.get.request":
        return this.reply(msg.requestId, "ompPlugins.management.get.response", () => this.service.getManagement(msg));
      case "ompPlugins.management.update.request":
        return this.reply(msg.requestId, "ompPlugins.management.update.response", () => this.service.updateManagement(msg));
      case "ompPlugins.list.request": {
        const requestId = msg.requestId;
        return this.reply(
          requestId,
          "ompPlugins.list.response",
          () => this.service.list(msg.cwd) as unknown as Promise<Record<string, unknown>>,
        );
      }
      case "ompPlugins.install.request": {
        const { requestId, spec, scope, dryRun, cwd } = msg;
        return this.reply(requestId, "ompPlugins.install.response", async () => {
          const result = await this.service.install({ spec, scope, dryRun, cwd });
          return { ok: result.ok, plugin: result.plugin ?? null, output: result.output };
        });
      }
      case "ompPlugins.upgrade.request": {
        const { requestId, name, scope, cwd } = msg;
        return this.reply(
          requestId,
          "ompPlugins.upgrade.response",
          () => this.service.upgrade(name, scope, cwd) as Promise<Record<string, unknown>>,
        );
      }
      case "ompPlugins.remove.request": {
        const { requestId, name, scope, cwd } = msg;
        return this.reply(
          requestId,
          "ompPlugins.remove.response",
          () => this.service.remove(name, scope, cwd) as Promise<Record<string, unknown>>,
        );
      }
      case "ompPlugins.setEnabled.request": {
        const { requestId, name, enabled, scope, cwd } = msg;
        return this.reply(requestId, "ompPlugins.setEnabled.response", async () => {
          const result = await this.service.setEnabled(name, enabled, scope, cwd);
          return { ok: result.ok, name, enabled, output: result.output };
        });
      }
      case "ompPlugins.doctor.request": {
        const requestId = msg.requestId;
        return this.reply(
          requestId,
          "ompPlugins.doctor.response",
          () =>
            this.service.doctor({ fix: msg.fix, cwd: msg.cwd }) as unknown as Promise<
              Record<string, unknown>
            >,
        );
      }
      case "ompPlugins.marketplace.list.request": {
        const requestId = msg.requestId;
        return this.reply(
          requestId,
          "ompPlugins.marketplace.list.response",
          () =>
            this.service.marketplaceList(msg.cwd) as unknown as Promise<Record<string, unknown>>,
        );
      }
      case "ompPlugins.marketplace.add.request": {
        const { requestId, source, cwd } = msg;
        return this.reply(requestId, "ompPlugins.marketplace.add.response", async () => {
          const result = await this.service.marketplaceAdd({ source, cwd });
          return { ok: result.ok, marketplace: result.marketplace ?? null, output: result.output };
        });
      }
      case "ompPlugins.marketplace.remove.request": {
        const { requestId, name, cwd } = msg;
        return this.reply(requestId, "ompPlugins.marketplace.remove.response", async () => {
          const result = await this.service.marketplaceRemove({ name, cwd });
          return { ok: result.ok, output: result.output };
        });
      }
      case "ompPlugins.marketplace.update.request": {
        const { requestId, name, cwd } = msg;
        return this.reply(requestId, "ompPlugins.marketplace.update.response", async () => {
          const result = await this.service.marketplaceUpdate({ name, cwd });
          return { ok: result.ok, output: result.output };
        });
      }
      default:
        return undefined;
    }
  }

  private async reply(
    requestId: string,
    responseType: SessionOutboundMessage["type"],
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const payload = await operation();
      this.emitFn({
        type: responseType,
        payload: { requestId, ...payload },
      } as SessionOutboundMessage);
    } catch (error) {
      this.logger.warn({ responseType }, "ompPlugins operation failed");
      this.emitFn({
        type: "rpc_error",
        payload: {
          requestId,
          requestType: responseType.replace(/\.response$/, ".request"),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
