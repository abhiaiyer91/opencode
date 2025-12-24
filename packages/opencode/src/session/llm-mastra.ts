import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { DynamicAgentInstructions } from "@mastra/core/agent"
import type { LLMShared } from "./llm-shared"
import type { MastraModelOutput, ChunkType } from "@mastra/core/stream"
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

export namespace MastraLLM {
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

    export async function stream(prepared: LLMShared.PreparedStream): Promise<MastraModelOutput> {
        const { log: l, system, params, maxOutputTokens, tools, langModel, input } = prepared
        const { Agent } = await import("@mastra/core/agent")

        const agent = new Agent({
            id: input.agent.name,
            name: input.agent.name,
            instructions: system.map((x) => ({
                role: "system",
                content: x,
            })) as DynamicAgentInstructions,
            // Cast to work around @ai-sdk/provider version mismatch between AI SDK and Mastra
            model: langModel as any,
            tools,
        })

        return agent.stream(input.messages, {
            onError(error) {
                l.error("stream error", {
                    error,
                })
            },
            maxSteps: input.maxSteps,
            modelSettings: {
                temperature: params.temperature,
                topP: params.topP,
                topK: params.topK,
                maxOutputTokens,
                maxRetries: input.retries ?? 0,
            },
            activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
            providerOptions: ProviderTransform.providerOptions(input.model, params.options),
            abortSignal: input.abort,
        })
    }

    export async function processStream(
        stream: MastraModelOutput,
        args: {
            input: ProcessStreamInput
            options: ProcessStreamOptions
            state: ProcessStreamState
        },
    ) {
        const { input, options, state } = args
        const { model, assistantMessage, sessionID, abort } = input
        const { DOOM_LOOP_THRESHOLD, shouldBreak, logger } = options
        const { toolcalls, getSnapshot, setSnapshot, setBlocked } = state

        let currentText: MessageV2.TextPart | undefined
        let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

        for await (const value of stream.fullStream) {
            abort.throwIfAborted()
            const chunk = value as ChunkType

            switch (chunk.type) {
                case "start":
                    SessionStatus.set(sessionID, { type: "busy" })
                    break

                case "reasoning-start": {
                    const payload = chunk.payload
                    if (payload.id in reasoningMap) {
                        continue
                    }
                    reasoningMap[payload.id] = {
                        id: Identifier.ascending("part"),
                        messageID: assistantMessage.id,
                        sessionID: assistantMessage.sessionID,
                        type: "reasoning",
                        text: "",
                        time: {
                            start: Date.now(),
                        },
                        metadata: payload.providerMetadata,
                    }
                    break
                }

                case "reasoning-delta": {
                    const payload = chunk.payload
                    if (payload.id in reasoningMap) {
                        const part = reasoningMap[payload.id]
                        part.text += payload.text
                        if (payload.providerMetadata) part.metadata = payload.providerMetadata
                        if (part.text) await Session.updatePart({ part, delta: payload.text })
                    }
                    break
                }

                case "reasoning-end": {
                    const payload = chunk.payload
                    if (payload.id in reasoningMap) {
                        const part = reasoningMap[payload.id]
                        part.text = part.text.trimEnd()

                        part.time = {
                            ...part.time,
                            end: Date.now(),
                        }
                        if (payload.providerMetadata) part.metadata = payload.providerMetadata
                        await Session.updatePart(part)
                        delete reasoningMap[payload.id]
                    }
                    break
                }

                case "tool-call-input-streaming-start": {
                    const payload = chunk.payload
                    const part = await Session.updatePart({
                        id: toolcalls[payload.toolCallId]?.id ?? Identifier.ascending("part"),
                        messageID: assistantMessage.id,
                        sessionID: assistantMessage.sessionID,
                        type: "tool",
                        tool: payload.toolName,
                        callID: payload.toolCallId,
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    })
                    toolcalls[payload.toolCallId] = part as MessageV2.ToolPart
                    break
                }

                case "tool-call-delta":
                    break

                case "tool-call": {
                    const payload = chunk.payload
                    const match = toolcalls[payload.toolCallId]
                    if (match) {
                        const part = await Session.updatePart({
                            ...match,
                            tool: payload.toolName,
                            state: {
                                status: "running",
                                input: (payload.args ?? {}) as Record<string, any>,
                                time: {
                                    start: Date.now(),
                                },
                            },
                            metadata: payload.providerMetadata,
                        })
                        toolcalls[payload.toolCallId] = part as MessageV2.ToolPart

                        const parts = await MessageV2.parts(assistantMessage.id)
                        const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                        if (
                            lastThree.length === DOOM_LOOP_THRESHOLD &&
                            lastThree.every(
                                (p) =>
                                    p.type === "tool" &&
                                    p.tool === payload.toolName &&
                                    p.state.status !== "pending" &&
                                    JSON.stringify(p.state.input) === JSON.stringify(payload.args),
                            )
                        ) {
                            const permission = await Agent.get(assistantMessage.mode).then((x) => x.permission)

                            if (permission.doom_loop === "ask") {
                                await Permission.ask({
                                    type: "doom_loop",
                                    pattern: payload.toolName,
                                    sessionID: assistantMessage.sessionID,
                                    messageID: assistantMessage.id,
                                    callID: payload.toolCallId,
                                    title: `Possible doom loop: "${payload.toolName}" called ${DOOM_LOOP_THRESHOLD} times with identical arguments`,
                                    metadata: {
                                        tool: payload.toolName,
                                        input: payload.args,
                                    },
                                })
                            } else if (permission.doom_loop === "deny") {
                                throw new Permission.RejectedError(
                                    assistantMessage.sessionID,
                                    "doom_loop",
                                    payload.toolCallId,
                                    {
                                        tool: payload.toolName,
                                        input: payload.args,
                                    },
                                    `You seem to be stuck in a doom loop, please stop repeating the same action`,
                                )
                            }
                        }
                    }
                    break
                }

                case "tool-result": {
                    const payload = chunk.payload
                    const match = toolcalls[payload.toolCallId]
                    if (match && match.state.status === "running") {
                        if (payload.isError) {
                            await Session.updatePart({
                                ...match,
                                state: {
                                    status: "error",
                                    input: (payload.args ?? {}) as Record<string, any>,
                                    error: typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result),
                                    metadata: payload.providerMetadata,
                                    time: {
                                        start: match.state.time.start,
                                        end: Date.now(),
                                    },
                                },
                            })
                        } else {
                            await Session.updatePart({
                                ...match,
                                state: {
                                    status: "completed",
                                    input: (payload.args ?? {}) as Record<string, any>,
                                    output: typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result),
                                    title: payload.toolName,
                                    metadata: payload.providerMetadata ?? {},
                                    time: {
                                        start: match.state.time.start,
                                        end: Date.now(),
                                    },
                                },
                            })
                        }

                        delete toolcalls[payload.toolCallId]
                    }
                    break
                }

                case "error":
                    throw (chunk as any).error

                case "step-start": {
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

                case "step-finish": {
                    // Mastra StepFinishPayload structure:
                    // - output.usage for usage data
                    // - stepResult.reason for finish reason
                    // - providerMetadata or metadata.providerMetadata for metadata
                    const payload = chunk.payload

                    const rawUsage = payload.output?.usage ?? {
                        inputTokens: 0,
                        outputTokens: 0,
                        totalTokens: 0,
                    }

                    const usage = Session.getUsage({
                        model: model,
                        usage: rawUsage,
                        metadata: payload.providerMetadata ?? payload.metadata?.providerMetadata,
                    })

                    const finishReason = payload.stepResult?.reason ?? "unknown"
                    assistantMessage.finish = finishReason
                    assistantMessage.cost += usage.cost
                    assistantMessage.tokens = usage.tokens
                    await Session.updatePart({
                        id: Identifier.ascending("part"),
                        reason: finishReason,
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

                case "text-start": {
                    const payload = chunk.payload
                    currentText = {
                        id: Identifier.ascending("part"),
                        messageID: assistantMessage.id,
                        sessionID: assistantMessage.sessionID,
                        type: "text",
                        text: "",
                        time: {
                            start: Date.now(),
                        },
                        metadata: payload.providerMetadata,
                    }
                    break
                }

                case "text-delta": {
                    const payload = chunk.payload
                    if (currentText) {
                        currentText.text += payload.text
                        if (payload.providerMetadata) currentText.metadata = payload.providerMetadata
                        if (currentText.text)
                            await Session.updatePart({
                                part: currentText,
                                delta: payload.text,
                            })
                    }
                    break
                }

                case "text-end": {
                    const payload = chunk.payload
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
                        if (payload.providerMetadata) currentText.metadata = payload.providerMetadata
                        await Session.updatePart(currentText)
                    }
                    currentText = undefined
                    break
                }

                case "finish":
                    break

                default:
                    logger.info("unhandled", {
                        type: chunk.type,
                    })
                    continue
            }
        }
    }
}
