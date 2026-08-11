import type { TuiStoreApi, WrenAdapter } from "@wren/adapter"
import type { JSX, ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

const adapterCtx = createSimpleContext<WrenAdapter, { adapter: WrenAdapter }>({
  name: "Adapter",
  init: (props) => props.adapter,
})

export const useAdapter = adapterCtx.use

const storeCtx = createSimpleContext<TuiStoreApi, { adapter: WrenAdapter }>({
  name: "Store",
  init: (props) => props.adapter.state,
})

export const useStore = storeCtx.use

const AdapterProvider = adapterCtx.provider
const StoreProviderImpl = storeCtx.provider

export function StoreProvider(props: ParentProps<{ adapter: WrenAdapter }>): JSX.Element {
  return (
    <AdapterProvider adapter={props.adapter}>
      <StoreProviderImpl adapter={props.adapter}>{props.children}</StoreProviderImpl>
    </AdapterProvider>
  )
}
