import type { PluginError } from "../../types/plugin.js"
import { logForDebugging } from "../../utils/debug.js"
import { errorMessage, toError } from "../../utils/errors.js"
import { logError } from "../../utils/log.js"
import { getWrenConfigSafe } from "../../utils/model/configBridge.js"
import { getPluginLspServers } from "../../utils/plugins/lspPluginIntegration.js"
import { loadAllPluginsCacheOnly } from "../../utils/plugins/pluginLoader.js"
import type { ScopedLspServerConfig } from "./types.js"

/**
 * Get all configured LSP servers: user-defined servers from the Wren config
 * (`lsp` field) merged with plugin-provided servers.
 *
 * - `lsp: false` in the Wren config disables ALL LSP servers (including
 *   plugin-provided ones).
 * - `lsp: { name: { command, args?, extensionToLanguage, env?, ... } }`
 *   adds user-defined servers; plugin servers are merged on top.
 * - Omitted means plugin-provided servers are loaded as usual.
 *
 * @returns Object containing servers configuration keyed by scoped server name
 */
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}
  const userServers: Record<string, ScopedLspServerConfig> = {}

  // User-defined servers from the Wren config. `false` is an explicit kill
  // switch for the whole feature.
  const wrenConfig = getWrenConfigSafe()
  if (wrenConfig?.lsp === false) {
    logForDebugging("[LSP] LSP disabled by config (lsp: false)")
    return { servers: {} }
  }
  if (typeof wrenConfig?.lsp === "object") {
    for (const [name, cfg] of Object.entries(wrenConfig.lsp)) {
      userServers[name] = {
        command: cfg.command,
        args: cfg.args,
        extensionToLanguage: cfg.extensionToLanguage,
        transport: cfg.transport ?? "stdio",
        ...(cfg.env !== undefined && { env: cfg.env }),
        ...(cfg.initializationOptions !== undefined && {
          initializationOptions: cfg.initializationOptions,
        }),
        scope: "dynamic",
        source: "user",
      }
    }
    logForDebugging(`[LSP] Loaded ${Object.keys(userServers).length} LSP server(s) from config`)
    Object.assign(allServers, userServers)
  }

  try {
    // Get all enabled plugins
    const { enabled: plugins } = await loadAllPluginsCacheOnly()

    // Load LSP servers from each plugin in parallel.
    // Each plugin is independent — results are merged in original order so
    // Object.assign collision precedence (later plugins win) is preserved.
    const results = await Promise.all(
      plugins.map(async (plugin) => {
        const errors: PluginError[] = []
        try {
          const scopedServers = await getPluginLspServers(plugin, errors)
          return { plugin, scopedServers, errors }
        } catch (e) {
          // Defensive: if one plugin throws, don't lose results from the
          // others. The previous serial loop implicitly tolerated this.
          logForDebugging(`Failed to load LSP servers for plugin ${plugin.name}: ${e}`, {
            level: "error",
          })
          return { plugin, scopedServers: undefined, errors }
        }
      }),
    )

    for (const { plugin, scopedServers, errors } of results) {
      const serverCount = scopedServers ? Object.keys(scopedServers).length : 0
      if (serverCount > 0) {
        // Merge into all servers (already scoped by getPluginLspServers)
        Object.assign(allServers, scopedServers)

        logForDebugging(`Loaded ${serverCount} LSP server(s) from plugin: ${plugin.name}`)
      }

      // Log any errors encountered
      if (errors.length > 0) {
        logForDebugging(`${errors.length} error(s) loading LSP servers from plugin: ${plugin.name}`)
      }
    }

    // Explicit user configuration wins over plugin-provided servers with
    // the same name.
    Object.assign(allServers, userServers)

    logForDebugging(`Total LSP servers loaded: ${Object.keys(allServers).length}`)
  } catch (error) {
    // Log error for monitoring production issues.
    // LSP is optional, so we don't throw - but we need visibility
    // into why plugin loading fails to improve the feature.
    logError(toError(error))

    logForDebugging(`Error loading LSP servers: ${errorMessage(error)}`)
  }

  return {
    servers: allServers,
  }
}
