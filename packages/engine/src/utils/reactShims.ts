/**
 * React hook shims — previously from @wren/stubs/react.
 *
 * The engine's vendored source imports React hooks for interactive code
 * paths (terminal UI, swarm polling, IDE selection). The headless
 * QueryEngine never renders React components; these no-op implementations
 * keep the modules importable without pulling in the real react package.
 */

export type ReactNode = string | number | boolean | null | undefined | readonly ReactNode[]
export type Ref<T = unknown> = ((instance: T | null) => void) | { readonly current: T | null } | null
export type RefObject<T = unknown> = { readonly current: T | null }
export type SetStateAction<S> = S | ((prevState: S) => S)
export type Dispatch<A> = (action: A) => void
export type Key = string | number | null
export type ComponentType<P = unknown> = (props: P) => null
export type FC<P = unknown> = (props: P) => null
export type ReactElement = { readonly type: unknown; readonly props: unknown }
export type PropsWithChildren<P = unknown> = P & { readonly children?: ReactNode }

export function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const value = typeof initialState === "function" ? (initialState as () => S)() : initialState
  return [value, () => {}]
}

export function useReducer<S, A>(
  _reducer: (state: S, action: A) => S,
  initialArg: S,
  _init?: (arg: S) => S,
): [S, Dispatch<A>] {
  return [initialArg, () => {}]
}

export function useEffect(_effect: () => void | (() => void), _deps?: ReadonlyArray<unknown>): void {}
export function useLayoutEffect(_effect: () => void | (() => void), _deps?: ReadonlyArray<unknown>): void {}

export function useRef<T>(initialValue?: T): { current: T | null } {
  return { current: initialValue ?? null }
}

export function useCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  _deps?: ReadonlyArray<unknown>,
): T {
  return callback
}

export function useMemo<T>(factory: () => T, _deps?: ReadonlyArray<unknown>): T {
  return factory()
}

export function useSyncExternalStore<T>(
  _subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  return getServerSnapshot ? getServerSnapshot() : getSnapshot()
}

export function useContext<T>(_context: unknown): T | undefined {
  return undefined
}

export function createContext<T>(_defaultValue?: T): {
  readonly $$typeof: symbol
  Provider: (props: { readonly value: T; readonly children?: ReactNode }) => null
} {
  return { $$typeof: Symbol.for("react.context"), Provider: () => null }
}

export function memo<P>(component: (props: P) => null): (props: P) => null {
  return component
}

export function forwardRef<T, P = unknown>(
  _render: (props: P, ref: Ref<T>) => null,
): (props: P) => null {
  return () => null
}

export function useImperativeHandle<T>(
  _ref: Ref<T>,
  _createHandle: () => T,
  _deps?: ReadonlyArray<unknown>,
): void {}

export function useDeferredValue<T>(value: T): T {
  return value
}

export function useTransition(): [boolean, (cb: () => void) => void] {
  return [false, (cb) => cb()]
}

export function useId(): string {
  return ""
}

export function createElement(_type: unknown, _props?: unknown, ..._children: unknown[]): null {
  return null
}

const React = {
  useState,
  useReducer,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
  useContext,
  createContext,
  memo,
  forwardRef,
  useImperativeHandle,
  useDeferredValue,
  useTransition,
  useId,
  createElement,
}

export default React
