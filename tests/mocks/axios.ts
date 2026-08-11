import { mock } from "bun:test"
import * as realAxios from "axios"

export type AxiosStubMethods = {
  get?: (url: string, config?: Record<string, unknown>) => Promise<unknown>
  request?: (config: Record<string, unknown>) => Promise<unknown>
  isAxiosError?: (error: unknown) => boolean
}

export type AxiosHandle = {
  useStubs: boolean
  stubs: AxiosStubMethods
}

let useStubs = false
const stubs: AxiosStubMethods = {}

/**
 * Mock the axios module with a stubbable facade.
 *
 * Bun's `mock.module` evaluates the factory ONCE at registration time, so
 * the returned module cannot depend on mutable state at build time. Instead
 * the facade decides per call: with `useStubs` true, axios calls route
 * through `handle.stubs`; otherwise they delegate to the real axios module
 * (captured here before any mock could interfere).
 *
 * Calling setupAxiosMock() again with `useStubs` false also undoes per-test
 * `mock.module("axios", ...)` registrations from other files (mock.module
 * is process-global, last-write-wins).
 */
export function setupAxiosMock(): AxiosHandle {
  const realDefault = (realAxios as unknown as { default?: unknown }).default ?? realAxios
  const facade = ((...args: unknown[]) => {
    if (useStubs) {
      if (stubs.request) return stubs.request(args[0] as Record<string, unknown>)
      throw new Error("axios mock: no request stub configured")
    }
    return (realDefault as (...a: unknown[]) => unknown)(...args)
  }) as unknown as Record<string, unknown> & ((...args: unknown[]) => unknown)

  const dispatch = (name: string, args: unknown[]): unknown => {
    if (useStubs) {
      const stub = stubs[name as keyof AxiosStubMethods]
      if (stub) return (stub as (...a: unknown[]) => unknown)(...args)
      throw new Error(`axios mock: no ${name} stub configured`)
    }
    const real = (realAxios as unknown as Record<string, unknown>)[name]
    if (typeof real === "function") return (real as (...a: unknown[]) => unknown)(...args)
    throw new Error(`axios mock: real axios has no ${name}`)
  }

  facade.get = (...args: unknown[]) => dispatch("get", args)
  facade.request = (...args: unknown[]) => dispatch("request", args)
  facade.isAxiosError = (...args: unknown[]) => dispatch("isAxiosError", args)
  facade.isCancel = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    (error as { __CANCEL__?: boolean }).__CANCEL__ === true
  facade.create = (config?: unknown) => {
    const instance = ((...args: unknown[]) =>
      dispatch("request", args)) as unknown as Record<string, unknown>
    instance.get = (...args: unknown[]) => dispatch("get", args)
    instance.request = (...args: unknown[]) => dispatch("request", args)
    instance.defaults = { headers: {} }
    instance.interceptors = { request: { use: () => 0 }, response: { use: () => 0 } }
    void config
    return instance
  }

  mock.module("axios", () => ({ default: facade, ...facade }))

  return {
    get useStubs(): boolean {
      return useStubs
    },
    set useStubs(value: boolean) {
      useStubs = value
    },
    get stubs(): AxiosStubMethods {
      return stubs
    },
  }
}
