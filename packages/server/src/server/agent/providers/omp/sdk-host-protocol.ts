import { z } from "zod";
import { ProxyPolicySchema } from "@omp-desktop/protocol/provider-config";
import { AgentSandboxSchema } from "@omp-desktop/protocol/messages";

export const OMP_SDK_ROOT_ENV = "OMP_DESKTOP_SDK_ROOT";
export const OMP_SDK_LAUNCH_ENV = "OMP_DESKTOP_SDK_LAUNCH";

export const OmpSdkHostLaunchSchema = z
  .object({
    cwd: z.string().min(1),
    sandbox: AgentSandboxSchema.optional(),
    systemPrompt: z.string().optional(),
    modelBridgeExtension: z.string().optional(),
    proxyPolicy: ProxyPolicySchema.optional(),
    protocolMode: z.enum(["rpc", "rpc-ui"]).optional(),
    model: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    session: z.string().optional(),
    noSession: z.boolean().optional(),
    extraArgs: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    configFiles: z.array(z.string()).optional(),
    desktopPluginPrompts: z.boolean().optional(),
  })
  .strict();

export type OmpSdkHostLaunch = z.infer<typeof OmpSdkHostLaunchSchema>;
