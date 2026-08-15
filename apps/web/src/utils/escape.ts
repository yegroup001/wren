import { onCleanup, onMount } from "solid-js"

/** Listens for Escape on the window and calls handler while active. */
export function useEscape(handler: () => void): void {
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") handler()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
}

/** Locks body scroll while the component is mounted. */
export function useBodyScrollLock(): void {
  onMount(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    onCleanup(() => {
      document.body.style.overflow = prev
    })
  })
}
