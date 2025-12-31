import { createMemo, For, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Locale } from "@/util/locale"
import type { AssistantMessage, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

export function DialogMemory(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  onMount(() => {
    dialog.setSize("large")
  })

  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return { tokens: 0, percentage: null }
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total,
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const stats = createMemo(() => {
    const msgs = messages()
    return {
      total: msgs.length,
      user: msgs.filter((x) => x.role === "user").length,
      assistant: msgs.filter((x) => x.role === "assistant").length,
    }
  })

  const height = createMemo(() => Math.floor(dimensions().height * 0.75))

  const getMessageContent = (messageID: string, role: string): string => {
    const parts = sync.data.part[messageID] ?? []

    if (role === "user") {
      const textPart = parts.find((p): p is TextPart => p.type === "text" && !p.synthetic && !p.ignored)
      if (!textPart) return "[No content]"
      return textPart.text.replace(/\n/g, " ").trim()
    }

    const textParts = parts.filter((p): p is TextPart => p.type === "text" && !p.synthetic)
    const text = textParts.length > 0 ? textParts[0].text.replace(/\n/g, " ").trim() : ""
    return text || "[No text]"
  }

  const getToolNames = (messageID: string): string[] => {
    const parts = sync.data.part[messageID] ?? []
    const toolParts = parts.filter((p): p is ToolPart => p.type === "tool")
    return [...new Set(toolParts.map((t) => t.tool))]
  }

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Memory
          </text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        <text fg={theme.textMuted}>
          {context().tokens.toLocaleString()} tokens ({context().percentage ?? 0}%) · {cost()} · {stats().total}{" "}
          messages
        </text>
      </box>
      <scrollbox paddingLeft={2} paddingRight={2} maxHeight={height()} scrollbarOptions={{ visible: false }}>
        <For each={messages()}>
          {(message) => {
            const isUser = message.role === "user"
            const content = getMessageContent(message.id, message.role)
            const tools = getToolNames(message.id)

            return (
              <box paddingLeft={2} paddingRight={2} paddingTop={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={isUser ? theme.primary : theme.accent} attributes={TextAttributes.BOLD}>
                    {isUser ? "You" : "Agent"}
                  </text>
                  <text fg={theme.textMuted}>{Locale.time(message.time.created)}</text>
                </box>
                <text fg={theme.text} paddingLeft={2}>
                  {Locale.truncate(content, 85)}
                </text>
                {!isUser && tools.length > 0 && (
                  <text fg={theme.textMuted} paddingLeft={2}>
                    Tools: {tools.join(", ")}
                  </text>
                )}
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}
