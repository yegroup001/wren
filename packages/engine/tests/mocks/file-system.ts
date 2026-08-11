import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function createTempDir(prefix = "test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export async function writeTempFile(dir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = join(dir, relativePath)
  const dirName = fullPath.slice(0, fullPath.lastIndexOf("/"))
  await mkdir(dirName, { recursive: true })
  await writeFile(fullPath, content, "utf-8")
  return fullPath
}
