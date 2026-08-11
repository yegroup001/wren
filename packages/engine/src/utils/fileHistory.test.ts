import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setIsInteractive, setOriginalCwd } from "../bootstrap/state.js"
import { _setGlobalConfigCacheForTesting } from "./config.js"
import {
  fileHistoryMakeSnapshot,
  fileHistoryRestoreSelective,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from "./fileHistory.js"

const root = join(process.cwd(), ".tmp-file-history-test")
const file = join(root, "app.ts")

let state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }

async function capture(updater: (previous: FileHistoryState) => FileHistoryState): Promise<void> {
  state = updater(state)
}

afterEach(async () => {
  state = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  await rm(root, { recursive: true, force: true })
  _setGlobalConfigCacheForTesting(null)
  delete process.env.WREN_ENABLE_SDK_FILE_CHECKPOINTING
})

describe("fileHistoryRestoreSelective", () => {
  test("restores only the selected file when its current content is unchanged", async () => {
    setIsInteractive(false)
    process.env.WREN_ENABLE_SDK_FILE_CHECKPOINTING = "1"
    setOriginalCwd(root)
    _setGlobalConfigCacheForTesting({ fileCheckpointingEnabled: true } as never)
    await mkdir(root, { recursive: true })
    await writeFile(file, "before")
    await fileHistoryMakeSnapshot(capture, "msg_boundary" as never)
    await fileHistoryTrackEdit(capture, file, "msg_boundary" as never)
    await fileHistoryMakeSnapshot(capture, "msg_after_track" as never)
    await writeFile(file, "after")
    const result = await fileHistoryRestoreSelective(state, "msg_boundary", [
      { path: file, expectedContent: "after" },
    ])

    expect(result).toEqual({ status: "restored", restoredPaths: [file] })
    expect(await readFile(file, "utf8")).toBe("before")
  })

  test("returns conflict without changing the file when the user changed it", async () => {
    setIsInteractive(false)
    process.env.WREN_ENABLE_SDK_FILE_CHECKPOINTING = "1"
    setOriginalCwd(root)
    _setGlobalConfigCacheForTesting({ fileCheckpointingEnabled: true } as never)
    await mkdir(root, { recursive: true })
    await writeFile(file, "before")
    await fileHistoryMakeSnapshot(capture, "msg_boundary" as never)
    await fileHistoryTrackEdit(capture, file, "msg_boundary" as never)
    await fileHistoryMakeSnapshot(capture, "msg_after_track" as never)
    await writeFile(file, "user change")

    const result = await fileHistoryRestoreSelective(state, "msg_boundary", [
      { path: file, expectedContent: "assistant result" },
    ])

    expect(result).toEqual({ status: "conflict", conflictedPaths: [file] })
    expect(await readFile(file, "utf8")).toBe("user change")
  })
})
