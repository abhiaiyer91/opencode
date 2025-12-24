import type { ModelMessage } from "ai"

export namespace Token {
  const CHARS_PER_TOKEN = 4

  export function estimate(input: string) {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
  }

  export function estimateSystem(system: string[]) {
    let total = 0
    for (const s of system) {
      total += estimate(s)
    }
    return total
  }

  export function estimateMessages(messages: ModelMessage[]) {
    let total = 0
    for (const msg of messages) {
      total += estimateMessage(msg)
    }
    return total
  }

  function estimateMessage(msg: ModelMessage): number {
    if (msg.role === "system") {
      return estimate(msg.content)
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") return estimate(msg.content)
      let total = 0
      for (const part of msg.content) {
        if (part.type === "text") total += estimate(part.text)
        // files/images are harder to estimate - use a rough approximation
        if (part.type === "file" || part.type === "image") total += 1000
      }
      return total
    }
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") return estimate(msg.content)
      let total = 0
      for (const part of msg.content) {
        if (part.type === "text") total += estimate(part.text)
        if (part.type === "reasoning") total += estimate(part.text)
        if (part.type === "tool-call") {
          total += estimate(part.toolName)
          total += estimate(JSON.stringify(part.input))
        }
        if (part.type === "tool-result") {
          total += estimate(JSON.stringify(part.output))
        }
      }
      return total
    }
    if (msg.role === "tool") {
      let total = 0
      for (const part of msg.content) {
        total += estimate(JSON.stringify(part.output))
      }
      return total
    }
    return 0
  }
}
