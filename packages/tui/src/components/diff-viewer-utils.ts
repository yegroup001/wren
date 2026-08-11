import type { SnapshotFileDiff } from "@wren/protocol"

export type DiffFileTreeRow = {
  readonly id: number
  readonly name: string
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly fileIndex: number | undefined
  readonly status: string | undefined
}

type TreeNode = {
  readonly id: number
  readonly name: string
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly fileIndex: number | undefined
  readonly status: string | undefined
  readonly children: Map<string, TreeNode>
}

function pathHash(path: string): number {
  let hash = 5381
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) | 0
  }
  return hash
}

export function buildFileTree(files: readonly SnapshotFileDiff[]): readonly TreeNode[] {
  const rootChildren = new Map<string, TreeNode>()

  files.forEach((file, fileIndex) => {
    const segments = file.path.split("/").filter((s) => s.length > 0)
    let currentChildren = rootChildren
    let currentPath = ""

    segments.forEach((segment, segIndex) => {
      const depth = segIndex + 1
      const isLeaf = segIndex === segments.length - 1
      const existing = currentChildren.get(segment)
      currentPath = currentPath ? `${currentPath}/${segment}` : segment

      if (existing) {
        currentChildren = existing.children
        return
      }

      const node: TreeNode = isLeaf
        ? {
            id: pathHash(currentPath),
            name: segment,
            depth,
            kind: "file",
            fileIndex,
            status: statusForFile(file),
            children: new Map(),
          }
        : {
            id: pathHash(currentPath),
            name: segment,
            depth,
            kind: "directory",
            fileIndex: undefined,
            status: undefined,
            children: new Map(),
          }
      currentChildren.set(segment, node)
      currentChildren = node.children
    })
  })

  return sortNodes([...rootChildren.values()])
}

export function flattenFileTree(
  nodes: readonly TreeNode[],
  expandedNodes: ReadonlySet<number>,
): readonly DiffFileTreeRow[] {
  const rows: DiffFileTreeRow[] = []

  function walk(nodeList: readonly TreeNode[], depth: number): void {
    const sorted = sortNodes(nodeList)
    for (const node of sorted) {
      rows.push({
        id: node.id,
        name: node.name,
        depth,
        kind: node.kind,
        fileIndex: node.fileIndex,
        status: node.status,
      })
      if (node.kind === "directory" && expandedNodes.has(node.id) && node.children.size > 0) {
        walk([...node.children.values()], depth + 1)
      }
    }
  }
  walk(nodes, 0)
  return rows
}

export function allExpandedDirectories(nodes: readonly TreeNode[]): ReadonlySet<number> {
  const result = new Set<number>()

  function walk(nodeList: readonly TreeNode[]): void {
    const sorted = sortNodes(nodeList)
    for (const node of sorted) {
      if (node.kind === "directory" && node.children.size > 0) {
        result.add(node.id)
        walk([...node.children.values()])
      }
    }
  }
  walk(nodes)
  return result
}

export function toggleDirectory(
  _nodes: readonly TreeNode[],
  expanded: ReadonlySet<number>,
  nodeId: number | undefined,
): ReadonlySet<number> {
  if (nodeId === undefined) return expanded
  const next = new Set(expanded)
  if (next.has(nodeId)) {
    next.delete(nodeId)
  } else {
    next.add(nodeId)
  }
  return next
}

export function moveSelection(
  rows: readonly DiffFileTreeRow[],
  current: number | undefined,
  offset: number,
): number | undefined {
  if (rows.length === 0) return undefined
  if (current === undefined) return offset > 0 ? rows[0]?.id : rows[rows.length - 1]?.id
  const idx = rows.findIndex((r) => r.id === current)
  if (idx === -1) return rows[0]?.id
  const next = idx + offset
  if (next < 0) return rows[0]?.id
  if (next >= rows.length) return rows[rows.length - 1]?.id
  return rows[next]?.id
}

export function nextFileIndex(
  rows: readonly DiffFileTreeRow[],
  current: number | undefined,
): number | undefined {
  const fileRows = rows.filter((r) => r.fileIndex !== undefined)
  if (fileRows.length === 0) return undefined
  if (current === undefined) return fileRows[0]?.fileIndex
  const idx = fileRows.findIndex((r) => r.fileIndex === current)
  if (idx === -1) return fileRows[0]?.fileIndex
  return (fileRows[idx + 1] ?? fileRows[0])?.fileIndex
}

export function prevFileIndex(
  rows: readonly DiffFileTreeRow[],
  current: number | undefined,
): number | undefined {
  const fileRows = rows.filter((r) => r.fileIndex !== undefined)
  if (fileRows.length === 0) return undefined
  if (current === undefined) return fileRows[fileRows.length - 1]?.fileIndex
  const idx = fileRows.findIndex((r) => r.fileIndex === current)
  if (idx === -1) return fileRows[fileRows.length - 1]?.fileIndex
  return (fileRows[idx - 1] ?? fileRows[fileRows.length - 1])?.fileIndex
}

function sortNodes(nodes: readonly TreeNode[]): readonly TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function statusForFile(file: SnapshotFileDiff): string {
  if (file.added > 0 && file.removed === 0) return "A"
  if (file.removed > 0 && file.added === 0) return "D"
  return "M"
}
