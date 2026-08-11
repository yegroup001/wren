import type { WrenClient } from "@wren/client"
import { createContext, type JSX, type ParentProps, useContext } from "solid-js"
import { type ClientStore, createClientStore } from "../state/client-store"

const ClientStoreContext = createContext<ClientStore | undefined>()

export function ClientStoreProvider(props: ParentProps<{ client: WrenClient }>): JSX.Element {
  const store = createClientStore(props.client)
  return <ClientStoreContext.Provider value={store}>{props.children}</ClientStoreContext.Provider>
}

export function useClientStore(): ClientStore {
  const store = useContext(ClientStoreContext)
  if (store === undefined) {
    throw new Error("useClientStore must be used within a ClientStoreProvider")
  }
  return store
}

export function useOptionalClientStore(): ClientStore | undefined {
  return useContext(ClientStoreContext)
}
