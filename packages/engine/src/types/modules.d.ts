/**
 * Ambient module declarations for optional dependencies that are loaded
 * dynamically at runtime via require()/import() but may not be installed.
 * These are type-only stubs — the actual packages are resolved at runtime.
 */

declare module "@anthropic/ink" {
  export const Byline: any
  export const KeyboardShortcutHint: any
}

declare module "cli-highlight" {
  export function highlight(
    code: string,
    language?: string,
    opts?: Record<string, unknown>,
  ): string
  export function supportsLanguage(name: string): boolean
}

declare module "fflate" {
  export interface UnzipFile {
    name: string
    originalSize?: number
  }
  export function unzipSync(
    data: Uint8Array,
    opts?: {
      filter?: (file: UnzipFile) => boolean
    },
  ): Record<string, Uint8Array>
  export function zipSync(
    files: Record<string, [Uint8Array, { os: number; attrs: number }]>,
    opts?: Record<string, unknown>,
  ): Uint8Array
}

declare module "plist" {
  export function parse(text: string): any
  export function build(obj: unknown): string
}

declare module "@napi-rs/keyring" {
  export class Entry {
    constructor(service: string, account: string)
    getPassword(): string | null
    setPassword(password: string): void
    deletePassword(): boolean
  }
}

declare module "@azure/identity" {
  export class DefaultAzureCredential {
    constructor()
  }
  export function getBearerTokenProvider(
    credential: unknown,
    scopes: string,
  ): () => Promise<string>
}

declare module "@aws-sdk/credential-providers" {
  export function fromIni(
    opts?: Record<string, unknown>,
  ): () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>
}

declare module "@smithy/node-http-handler" {
  export class NodeHttpHandler {
    constructor(opts?: Record<string, unknown>)
  }
}

declare module "@smithy/core" {
  export class NoAuthSigner {}
}

declare module "turndown" {
  class TurndownService {
    constructor(options?: Record<string, unknown>)
    turndown(html: string): string
    addRule(key: string, rule: Record<string, unknown>): this
    remove(key: string): this
    use(plugin: unknown): this
  }
  export = TurndownService
}
