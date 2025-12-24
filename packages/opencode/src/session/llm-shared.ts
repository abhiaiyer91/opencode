import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { wrapLanguageModel, type ModelMessage, type StreamTextResult, type Tool, type ToolSet } from "ai"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { ToolRegistry } from "@/tool/registry"
import { Flag } from "@/flag/flag"

export namespace LLMShared {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    maxSteps?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export type PreparedStream = {
    log: typeof log
    config: Config.Info
    system: string[]
    params: {
      temperature: number | undefined
      topP: number | undefined
      topK: number | undefined
      options: Record<string, unknown>
    }
    maxOutputTokens: number
    tools: Record<string, Tool>
    langModel: ReturnType<typeof wrapLanguageModel>
    input: StreamInput
  }

  export async function prepare(input: StreamInput): Promise<PreparedStream> {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })

    const [language, cfg] = await Promise.all([Provider.getLanguage(input.model), Config.get()])

    const system = SystemPrompt.header(input.model.providerID)
    system.push(
      [
        // use agent prompt otherwise provider prompt
        ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    const original = clone(system)
    await Plugin.trigger("experimental.chat.system.transform", {}, { system })
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const provider = await Provider.getProvider(input.model.providerID)

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider: Provider.getProvider(input.model.providerID),
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options: pipe(
          {},
          mergeDeep(ProviderTransform.options(input.model, input.sessionID, provider.options)),
          input.small ? mergeDeep(ProviderTransform.smallOptions(input.model)) : mergeDeep({}),
          mergeDeep(input.model.options),
          mergeDeep(input.agent.options),
        ),
      },
    )

    l.info("params", {
      params,
    })

    const maxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model.api.npm,
      params.options,
      input.model.limit.output,
      OUTPUT_TOKEN_MAX,
    )

    const tools = await resolveTools(input)

    // Cast to work around @ai-sdk/provider version mismatch between dependencies
    const langModel = wrapLanguageModel({
      model: language as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: [
        {
          async transformParams(args) {
            if (args.type === "stream") {
              // @ts-expect-error
              args.params.prompt = ProviderTransform.message(args.params.prompt, input.model)
            }
            return args.params
          },
        },
      ],
    })

    return {
      log: l,
      config: cfg,
      system,
      params,
      maxOutputTokens,
      tools,
      langModel,
      input,
    }
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const enabled = pipe(
      input.agent.tools,
      mergeDeep(await ToolRegistry.enabled(input.agent)),
      mergeDeep(input.user.tools ?? {}),
    )
    for (const [key, value] of Object.entries(enabled)) {
      if (value === false) delete input.tools[key]
    }
    return input.tools
  }
}
