import { streamText, type ModelMessage } from "ai"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Instance } from "@/project/instance"
import { Flag } from "@/flag/flag"
import { LLMShared } from "./llm-shared"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Plugin } from "@/plugin"
import type { Log } from "@/util/log"

export namespace LLM {
  // Re-export shared types for backwards compatibility
  export type StreamInput = LLMShared.StreamInput
  export type StreamOutput = LLMShared.StreamOutput
  export type PreparedStream = LLMShared.PreparedStream
  export const prepare = LLMShared.prepare
  export const OUTPUT_TOKEN_MAX = LLMShared.OUTPUT_TOKEN_MAX

  /**
   * Convenience function that combines prepare + stream for simple callers.
   * Use this when you don't need custom stream processing.
   */
  export async function streamFromInput(input: StreamInput): Promise<StreamOutput> {
    const prepared = await prepare(input)
    return stream(prepared)
  }

  export type ProcessStreamInput = {
    model: Provider.Model
    assistantMessage: MessageV2.Assistant
    sessionID: string
    abort: AbortSignal
  }

  export type ProcessStreamOptions = {
    DOOM_LOOP_THRESHOLD: number
    shouldBreak: boolean
    logger: Log.Logger
  }

  export type ProcessStreamState = {
    toolcalls: Record<string, MessageV2.ToolPart>
    getSnapshot: () => string | undefined
    setSnapshot: (snapshot: string | undefined) => void
    setBlocked: (blocked: boolean) => void
  }

  export async function stream(prepared: PreparedStream): Promise<StreamOutput> {
    const { log: l, config: cfg, system, params, maxOutputTokens, tools, langModel, input } = prepared

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
            "x-opencode-project": Instance.project.id,
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": Flag.OPENCODE_CLIENT,
          }
          : undefined),
        ...input.model.headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: langModel,
      experimental_telemetry: { isEnabled: cfg.experimental?.openTelemetry },
    })
  }

  export async function processStream(
    stream: StreamOutput,
    args: {
      input: ProcessStreamInput
      options: ProcessStreamOptions
      state: ProcessStreamState
    }
  ) {
    const { input, options, state } = args
    const { model, assistantMessage, sessionID, abort } = input
    const { DOOM_LOOP_THRESHOLD, shouldBreak, logger } = options
    const { toolcalls, getSnapshot, setSnapshot, setBlocked } = state

    let currentText: MessageV2.TextPart | undefined
    let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

    for await (const value of stream.fullStream) {
      abort.throwIfAborted()
      switch (value.type) {
        case "start":
          SessionStatus.set(sessionID, { type: "busy" })
          break

        case "reasoning-start":
          if (value.id in reasoningMap) {
            continue
          }
          reasoningMap[value.id] = {
            id: Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
            type: "reasoning",
            text: "",
            time: {
              start: Date.now(),
            },
            metadata: value.providerMetadata,
          }
          break

        case "reasoning-delta":
          if (value.id in reasoningMap) {
            const part = reasoningMap[value.id]
            part.text += value.text
            if (value.providerMetadata) part.metadata = value.providerMetadata
            if (part.text) await Session.updatePart({ part, delta: value.text })
          }
          break

        case "reasoning-end":
          if (value.id in reasoningMap) {
            const part = reasoningMap[value.id]
            part.text = part.text.trimEnd()

            part.time = {
              ...part.time,
              end: Date.now(),
            }
            if (value.providerMetadata) part.metadata = value.providerMetadata
            await Session.updatePart(part)
            delete reasoningMap[value.id]
          }
          break

        case "tool-input-start": {
          const part = await Session.updatePart({
            id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
            type: "tool",
            tool: value.toolName,
            callID: value.id,
            state: {
              status: "pending",
              input: {},
              raw: "",
            },
          })
          toolcalls[value.id] = part as MessageV2.ToolPart
          break
        }

        case "tool-input-delta":
          break

        case "tool-input-end":
          break

        case "tool-call": {
          const match = toolcalls[value.toolCallId]
          if (match) {
            const part = await Session.updatePart({
              ...match,
              tool: value.toolName,
              state: {
                status: "running",
                input: value.input,
                time: {
                  start: Date.now(),
                },
              },
              metadata: value.providerMetadata,
            })
            toolcalls[value.toolCallId] = part as MessageV2.ToolPart

            const parts = await MessageV2.parts(assistantMessage.id)
            const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              lastThree.length === DOOM_LOOP_THRESHOLD &&
              lastThree.every(
                (p) =>
                  p.type === "tool" &&
                  p.tool === value.toolName &&
                  p.state.status !== "pending" &&
                  JSON.stringify(p.state.input) === JSON.stringify(value.input),
              )
            ) {
              const permission = await Agent.get(assistantMessage.mode).then((x) => x.permission)

              if (permission.doom_loop === "ask") {
                await Permission.ask({
                  type: "doom_loop",
                  pattern: value.toolName,
                  sessionID: assistantMessage.sessionID,
                  messageID: assistantMessage.id,
                  callID: value.toolCallId,
                  title: `Possible doom loop: "${value.toolName}" called ${DOOM_LOOP_THRESHOLD} times with identical arguments`,
                  metadata: {
                    tool: value.toolName,
                    input: value.input,
                  },
                })
              } else if (permission.doom_loop === "deny") {
                throw new Permission.RejectedError(
                  assistantMessage.sessionID,
                  "doom_loop",
                  value.toolCallId,
                  {
                    tool: value.toolName,
                    input: value.input,
                  },
                  `You seem to be stuck in a doom loop, please stop repeating the same action`,
                )
              }
            }
          }
          break
        }

        case "tool-result": {
          const match = toolcalls[value.toolCallId]
          if (match && match.state.status === "running") {
            await Session.updatePart({
              ...match,
              state: {
                status: "completed",
                input: value.input,
                output: value.output.output,
                metadata: value.output.metadata,
                title: value.output.title,
                time: {
                  start: match.state.time.start,
                  end: Date.now(),
                },
                attachments: value.output.attachments,
              },
            })

            delete toolcalls[value.toolCallId]
          }
          break
        }

        case "tool-error": {
          const match = toolcalls[value.toolCallId]
          if (match && match.state.status === "running") {
            await Session.updatePart({
              ...match,
              state: {
                status: "error",
                input: value.input,
                error: (value.error as any).toString(),
                metadata: value.error instanceof Permission.RejectedError ? value.error.metadata : undefined,
                time: {
                  start: match.state.time.start,
                  end: Date.now(),
                },
              },
            })

            if (value.error instanceof Permission.RejectedError) {
              setBlocked(shouldBreak)
            }
            delete toolcalls[value.toolCallId]
          }
          break
        }

        case "error":
          throw value.error

        case "start-step": {
          const snapshot = await Snapshot.track()
          setSnapshot(snapshot)

          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: sessionID,
            snapshot,
            type: "step-start",
          })
          break
        }

        case "finish-step": {
          const usage = Session.getUsage({
            model: model,
            usage: value.usage,
            metadata: value.providerMetadata,
          })
          assistantMessage.finish = value.finishReason
          assistantMessage.cost += usage.cost
          assistantMessage.tokens = usage.tokens
          await Session.updatePart({
            id: Identifier.ascending("part"),
            reason: value.finishReason,
            snapshot: await Snapshot.track(),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
            type: "step-finish",
            tokens: usage.tokens,
            cost: usage.cost,
          })
          await Session.updateMessage(assistantMessage)

          const snapshot = getSnapshot()
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: assistantMessage.id,
                sessionID: sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            setSnapshot(undefined)
          }

          SessionSummary.summarize({
            sessionID: sessionID,
            messageID: assistantMessage.parentID,
          })
          break
        }

        case "text-start":
          currentText = {
            id: Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
            type: "text",
            text: "",
            time: {
              start: Date.now(),
            },
            metadata: value.providerMetadata,
          }
          break

        case "text-delta":
          if (currentText) {
            currentText.text += value.text
            if (value.providerMetadata) currentText.metadata = value.providerMetadata
            if (currentText.text)
              await Session.updatePart({
                part: currentText,
                delta: value.text,
              })
          }
          break

        case "text-end":
          if (currentText) {
            currentText.text = currentText.text.trimEnd()
            const textOutput = await Plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: sessionID,
                messageID: assistantMessage.id,
                partID: currentText.id,
              },
              { text: currentText.text },
            )
            currentText.text = textOutput.text
            currentText.time = {
              start: Date.now(),
              end: Date.now(),
            }
            if (value.providerMetadata) currentText.metadata = value.providerMetadata
            await Session.updatePart(currentText)
          }
          currentText = undefined
          break

        case "finish":
          break

        default:
          logger.info("unhandled", {
            ...value,
          })
          continue
      }
    }
  }
}
