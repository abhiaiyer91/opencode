import { MCPClient, type MastraMCPServerDefinition } from "@mastra/mcp"
import type { Tool } from "ai"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { McpAuth } from "./auth"
import { Installation } from "../installation"

const log = Log.create({ service: "mcp.mastra" })

/**
 * Get OAuth Bearer token headers for a remote MCP server if authenticated
 */
async function getAuthHeaders(key: string, mcp: Config.Mcp): Promise<Record<string, string> | undefined> {
  if (mcp.type !== "remote") return undefined
  if (mcp.oauth === false) return undefined

  const entry = await McpAuth.getForUrl(key, mcp.url)
  if (!entry?.tokens?.accessToken) return undefined

  // Check if token is expired
  if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) {
    log.debug("oauth token expired", { key })
    return undefined
  }

  return {
    Authorization: `Bearer ${entry.tokens.accessToken}`,
  }
}

/**
 * Convert opencode MCP config to Mastra MCPClient server definition
 */
async function toMastraServerDefinition(key: string, mcp: Config.Mcp): Promise<MastraMCPServerDefinition | undefined> {
  if (mcp.enabled === false) {
    return undefined
  }

  if (mcp.type === "local") {
    const [command, ...args] = mcp.command
    return {
      command,
      args,
      env: {
        ...process.env,
        ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}),
        ...mcp.environment,
      } as Record<string, string>,
      timeout: mcp.timeout,
    }
  }

  if (mcp.type === "remote") {
    const authHeaders = await getAuthHeaders(key, mcp)
    const headers: Record<string, string> = {
      ...mcp.headers,
      ...authHeaders,
    }

    return {
      url: new URL(mcp.url),
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      timeout: mcp.timeout,
    }
  }

  return undefined
}

/**
 * Create a Mastra MCPClient from opencode config.
 * Returns the client and list of server keys that were configured.
 */
export async function createMastraClient(
  config: Record<string, Config.Mcp>,
): Promise<{ client: MCPClient; serverKeys: string[] }> {
  const servers: Record<string, MastraMCPServerDefinition> = {}
  const serverKeys: string[] = []

  for (const [key, mcp] of Object.entries(config)) {
    if (mcp.enabled === false) continue

    const definition = await toMastraServerDefinition(key, mcp)

    if (definition) {
      servers[key] = definition
      serverKeys.push(key)
    }
  }

  const client = new MCPClient({
    id: `opencode-${Installation.VERSION}`,
    servers,
    timeout: 60000,
  })

  return { client, serverKeys }
}

/**
 * Get tools from Mastra MCPClient with proper namespacing.
 * Tools are returned with names in format: serverName_toolName
 */
export async function getMastraTools(client: MCPClient): Promise<Record<string, Tool>> {
  const tools = await client.listTools()
  const result: Record<string, Tool> = {}

  for (const [name, tool] of Object.entries(tools)) {
    // Mastra already namespaces tools as serverName_toolName
    // Sanitize the name to match opencode's convention
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_")
    result[sanitized] = tool as Tool
  }

  return result
}
