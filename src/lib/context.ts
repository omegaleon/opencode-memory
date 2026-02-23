import type { PluginInput } from "@opencode-ai/plugin"

export interface ContextInfo {
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  model: {
    id: string
    providerID: string
    contextLimit: number
  }
  percentage: number
}

/**
 * Get context usage for the current session by finding the last assistant
 * message with token data and looking up the model's context limit.
 */
export async function getContextUsage(
  client: PluginInput["client"],
  sessionID: string
): Promise<ContextInfo | null> {
  try {
    const { data: messages } = await client.session.messages({
      path: { id: sessionID },
    })

    if (!messages) return null

    // Find the last assistant message with output tokens
    const lastAssistant = [...messages]
      .reverse()
      .find(
        (m) =>
          m.info.role === "assistant" &&
          "tokens" in m.info &&
          (m.info as any).tokens?.output > 0
      )

    if (!lastAssistant) return null

    const info = lastAssistant.info as any
    const tokens = info.tokens
    if (!tokens) return null

    const total =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0)

    // Look up the model's context limit
    const { data: configProviders } = await client.config.providers()
    if (!configProviders) return null

    let contextLimit = 0
    let modelName = info.modelID ?? "unknown"
    let providerID = info.providerID ?? "unknown"

    for (const provider of configProviders.providers) {
      if (provider.id === providerID) {
        const model = provider.models[modelName]
        if (model) {
          contextLimit = model.limit.context
        }
        break
      }
    }

    const percentage = contextLimit > 0
      ? Math.round((total / contextLimit) * 100)
      : 0

    return {
      tokens: {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        cacheRead: tokens.cache?.read ?? 0,
        cacheWrite: tokens.cache?.write ?? 0,
        total,
      },
      model: {
        id: modelName,
        providerID,
        contextLimit,
      },
      percentage,
    }
  } catch {
    return null
  }
}
