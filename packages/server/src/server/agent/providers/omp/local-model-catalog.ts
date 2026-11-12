import { LOCAL_MODEL_PROVIDER, LocalModelCatalogSchema, type LocalModel } from "@omp-desktop/protocol/local-models";
import type { OmpModel } from "./rpc-types.js";

/** Public inference metadata only; credentials, account identities and host URLs never leave the source. */
export function projectOmpLocalModelCatalog(catalog: readonly OmpModel[]): LocalModel[] {
  return LocalModelCatalogSchema.parse(catalog
    .filter(model => model.provider !== LOCAL_MODEL_PROVIDER && model.provider !== "omp-desktop-bootstrap" && (model.kind === undefined || model.kind === "chat"))
    .map(model => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      thinking: model.thinking,
      cost: model.cost,
      serviceTiers: model.serviceTiers,
      contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined,
      maxTokens: typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined,
    })));
}
