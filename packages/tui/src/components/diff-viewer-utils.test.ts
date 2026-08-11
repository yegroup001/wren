import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@wren/protocol"
import {
  allExpandedDirectories,
  buildFileTree,
  type DiffFileTreeRow,
  flattenFileTree,
  moveSelection,
  nextFileIndex,
  prevFileIndex,
  toggleDirectory,
} from "./diff-viewer-utils"

function makeFile(path: string, added = 0, removed = 0): SnapshotFileDiff {
  return { path, added, removed } as unknown as SnapshotFileDiff
}

describe("buildFileTree", () => {
  test("builds tree from flat file list", () => {
    const tree = buildFileTree([
      makeFile("src/index.ts", 10, 2),
      makeFile("src/utils.ts", 5, 0),
      makeFile("README.md", 1, 0),
    ])
    // Root: src/ (dir), README.md (file)
    expect(tree).toHaveLength(2)
    expect(tree[0].kind).toBe("directory")
    expect(tree[0].name).toBe("src")
    expect(tree[1].kind).toBe("file")
    expect(tree[1].name).toBe("README.md")
  })

  test("directories come before files", () => {
    const tree = buildFileTree([
      makeFile("zfile.ts"),
      makeFile("adir/file.ts"),
      makeFile("bdir/file.ts"),
    ])
    expect(tree[0].name).toBe("adir")
    expect(tree[1].name).toBe("bdir")
    expect(tree[2].name).toBe("zfile.ts")
  })

  test("sorts directories alphabetically", () => {
    const tree = buildFileTree([
      makeFile("zdir/a.ts"),
      makeFile("adir/b.ts"),
      makeFile("mdir/c.ts"),
    ])
    expect(tree.map((n) => n.name)).toEqual(["adir", "mdir", "zdir"])
  })

  test("nests files in directories", () => {
    const tree = buildFileTree([makeFile("src/a.ts"), makeFile("src/sub/b.ts")])
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe("src")
    // Flatten with all expanded to see children
    const allExp = allExpandedDirectories(tree)
    const rows = flattenFileTree(tree, allExp)
    expect(rows.filter((r) => r.kind === "file")).toHaveLength(2)
    expect(rows.some((r) => r.name === "b.ts" && r.depth === 2)).toBe(true)
  })
})

describe("flattenFileTree", () => {
  test("returns only top-level rows when nothing expanded", () => {
    const tree = buildFileTree([
      makeFile("src/a.ts"),
      makeFile("src/sub/b.ts"),
      makeFile("root.ts"),
    ])
    const rows = flattenFileTree(tree, new Set())
    expect(rows).toHaveLength(2) // src/ (dir), root.ts (file)
    expect(rows[0].name).toBe("src")
    expect(rows[1].name).toBe("root.ts")
  })

  test("includes children when directory is expanded", () => {
    const tree = buildFileTree([makeFile("dir/a.ts"), makeFile("dir/b.ts")])
    const rows = flattenFileTree(tree, allExpandedDirectories(tree))
    expect(rows).toHaveLength(3) // dir/ + a.ts + b.ts
    expect(rows[0].depth).toBe(0)
    expect(rows[1].depth).toBe(1)
    expect(rows[2].depth).toBe(1)
  })

  test("fileIndex is set for files, undefined for directories", () => {
    const tree = buildFileTree([makeFile("dir/a.ts")])
    const rows = flattenFileTree(tree, allExpandedDirectories(tree))
    const dirRow = rows.find((r) => r.kind === "directory")
    const fileRow = rows.find((r) => r.kind === "file")
    expect(dirRow?.fileIndex).toBeUndefined()
    expect(fileRow?.fileIndex).toBe(0)
  })

  test("status is set for files, undefined for directories", () => {
    const tree = buildFileTree([makeFile("dir/a.ts", 10, 0)])
    const rows = flattenFileTree(tree, allExpandedDirectories(tree))
    const fileRow = rows.find((r) => r.kind === "file")
    expect(fileRow?.status).toBe("A") // added > 0, removed === 0
  })
})

describe("allExpandedDirectories", () => {
  test("returns all directory ids", () => {
    const tree = buildFileTree([makeFile("a/b/c.ts"), makeFile("a/d.ts")])
    const expanded = allExpandedDirectories(tree)
    expect(expanded.size).toBe(2) // a/ and b/
  })

  test("returns empty set for flat file list", () => {
    const tree = buildFileTree([makeFile("file.ts")])
    const expanded = allExpandedDirectories(tree)
    expect(expanded.size).toBe(0)
  })
})

describe("toggleDirectory", () => {
  test("adds directory to expanded set", () => {
    const tree = buildFileTree([makeFile("dir/a.ts")])
    const dirId = allExpandedDirectories(tree).values().next().value
    const result = toggleDirectory(tree, new Set(), dirId)
    expect(result.has(dirId)).toBe(true)
  })

  test("removes directory from expanded set", () => {
    const tree = buildFileTree([makeFile("dir/a.ts")])
    const dirId = allExpandedDirectories(tree).values().next().value
    const result = toggleDirectory(tree, new Set([dirId]), dirId)
    expect(result.has(dirId)).toBe(false)
  })

  test("returns unchanged set for undefined nodeId", () => {
    const original = new Set([1, 2, 3])
    const result = toggleDirectory([], original, undefined)
    expect(result).toBe(original)
  })
})

describe("moveSelection", () => {
  const rows: DiffFileTreeRow[] = [
    { id: 1, name: "a", depth: 0, kind: "file", fileIndex: 0, status: "M" },
    { id: 2, name: "b", depth: 0, kind: "file", fileIndex: 1, status: "M" },
    { id: 3, name: "c", depth: 0, kind: "file", fileIndex: 2, status: "M" },
  ]

  test("moves down by 1", () => {
    expect(moveSelection(rows, 1, 1)).toBe(2)
  })

  test("moves up by 1", () => {
    expect(moveSelection(rows, 2, -1)).toBe(1)
  })

  test("clamps at top", () => {
    expect(moveSelection(rows, 1, -1)).toBe(1)
  })

  test("clamps at bottom", () => {
    expect(moveSelection(rows, 3, 1)).toBe(3)
  })

  test("returns first row when current is undefined and offset > 0", () => {
    expect(moveSelection(rows, undefined, 1)).toBe(1)
  })

  test("returns last row when current is undefined and offset < 0", () => {
    expect(moveSelection(rows, undefined, -1)).toBe(3)
  })

  test("returns undefined for empty rows", () => {
    expect(moveSelection([], undefined, 1)).toBeUndefined()
  })

  test("returns first row when current not found", () => {
    expect(moveSelection(rows, 999, 1)).toBe(1)
  })
})

describe("nextFileIndex", () => {
  const rows: DiffFileTreeRow[] = [
    { id: 1, name: "dir", depth: 0, kind: "directory", fileIndex: undefined, status: undefined },
    { id: 2, name: "a.ts", depth: 1, kind: "file", fileIndex: 0, status: "M" },
    { id: 3, name: "b.ts", depth: 1, kind: "file", fileIndex: 1, status: "A" },
  ]

  test("returns first file index when current is undefined", () => {
    expect(nextFileIndex(rows, undefined)).toBe(0)
  })

  test("returns next file index", () => {
    expect(nextFileIndex(rows, 0)).toBe(1)
  })

  test("wraps to first file", () => {
    expect(nextFileIndex(rows, 1)).toBe(0)
  })

  test("returns undefined when no files", () => {
    const noFileRows: DiffFileTreeRow[] = [
      { id: 1, name: "dir", depth: 0, kind: "directory", fileIndex: undefined, status: undefined },
    ]
    expect(nextFileIndex(noFileRows, undefined)).toBeUndefined()
  })
})

describe("prevFileIndex", () => {
  const rows: DiffFileTreeRow[] = [
    { id: 1, name: "dir", depth: 0, kind: "directory", fileIndex: undefined, status: undefined },
    { id: 2, name: "a.ts", depth: 1, kind: "file", fileIndex: 0, status: "M" },
    { id: 3, name: "b.ts", depth: 1, kind: "file", fileIndex: 1, status: "A" },
  ]

  test("returns last file index when current is undefined", () => {
    expect(prevFileIndex(rows, undefined)).toBe(1)
  })

  test("returns previous file index", () => {
    expect(prevFileIndex(rows, 1)).toBe(0)
  })

  test("wraps to last file", () => {
    expect(prevFileIndex(rows, 0)).toBe(1)
  })

  test("returns undefined when no files", () => {
    const noFileRows: DiffFileTreeRow[] = [
      { id: 1, name: "dir", depth: 0, kind: "directory", fileIndex: undefined, status: undefined },
    ]
    expect(prevFileIndex(noFileRows, undefined)).toBeUndefined()
  })
})

describe("file status", () => {
  test("A status for added-only files", () => {
    const tree = buildFileTree([makeFile("a.ts", 10, 0)])
    const rows = flattenFileTree(tree, new Set())
    expect(rows[0].status).toBe("A")
  })

  test("D status for removed-only files", () => {
    const tree = buildFileTree([makeFile("a.ts", 0, 5)])
    const rows = flattenFileTree(tree, new Set())
    expect(rows[0].status).toBe("D")
  })

  test("M status for modified files", () => {
    const tree = buildFileTree([makeFile("a.ts", 10, 5)])
    const rows = flattenFileTree(tree, new Set())
    expect(rows[0].status).toBe("M")
  })
})
