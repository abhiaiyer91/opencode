import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Snapshot } from "@/snapshot"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { MastraLLM } from "./llm-mastra"
import { Config } from "@/config/config"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        const config = await Config.get()
        const shouldBreak = config.experimental?.continue_loop_on_deny !== true
        const isMastra = config.experimental?.mastra?.enabled === true

        while (true) {
          try {
            const prepared = await LLM.prepare(streamInput)

            if (isMastra) {
              const stream = await MastraLLM.stream(prepared)
              await MastraLLM.processStream(stream, {
                input: {
                  model: input.model,
                  assistantMessage: input.assistantMessage,
                  sessionID: input.sessionID,
                  abort: input.abort,
                },
                options: {
                  DOOM_LOOP_THRESHOLD,
                  shouldBreak,
                  logger: log,
                },
                state: {
                  toolcalls,
                  getSnapshot: () => snapshot,
                  setSnapshot: (s) => {
                    snapshot = s
                  },
                  setBlocked: (b) => {
                    blocked = b
                  },
                },
              })
            } else {
              const stream = await LLM.stream(prepared)
              await LLM.processStream(stream, {
                input: {
                  model: input.model,
                  assistantMessage: input.assistantMessage,
                  sessionID: input.sessionID,
                  abort: input.abort,
                },
                options: {
                  DOOM_LOOP_THRESHOLD,
                  shouldBreak,
                  logger: log,
                },
                state: {
                  toolcalls,
                  getSnapshot: () => snapshot,
                  setSnapshot: (s) => {
                    snapshot = s
                  },
                  setBlocked: (b) => {
                    blocked = b
                  },
                },
              })
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => { })
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }

          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }

          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }

          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)

          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
