import { describe, expect, test } from "bun:test"
import { SPINNER_FRAMES, SpinnerFrames } from "./spinner"

describe("SPINNER_FRAMES", () => {
  test("includes dots style with multiple frames", () => {
    expect(SPINNER_FRAMES.dots).toBeDefined()
    expect(SPINNER_FRAMES.dots.length).toBeGreaterThan(1)
  })

  test("includes line style", () => {
    expect(SPINNER_FRAMES.line).toBeDefined()
    expect(SPINNER_FRAMES.line.length).toBe(4)
  })

  test("includes bar style", () => {
    expect(SPINNER_FRAMES.bar).toBeDefined()
  })

  test("includes arrow style with 8 frames", () => {
    expect(SPINNER_FRAMES.arrow).toBeDefined()
    expect(SPINNER_FRAMES.arrow.length).toBe(8)
  })

  test("every style has at least one frame", () => {
    for (const [name, frames] of Object.entries(SPINNER_FRAMES)) {
      expect(frames.length, `style ${name}`).toBeGreaterThan(0)
    }
  })

  test("every frame is a non-empty string", () => {
    for (const [name, frames] of Object.entries(SPINNER_FRAMES)) {
      for (const frame of frames) {
        expect(typeof frame).toBe("string")
        expect(frame.length, `style ${name}`).toBeGreaterThan(0)
      }
    }
  })
})

describe("SpinnerFrames", () => {
  test("returns frames for known style", () => {
    expect(SpinnerFrames("dots")).toBe(SPINNER_FRAMES.dots)
    expect(SpinnerFrames("line")).toBe(SPINNER_FRAMES.line)
  })

  test("returns fallback for unknown style", () => {
    const result = SpinnerFrames("nonexistent" as never)
    expect(result).toBeDefined()
    expect(result.length).toBeGreaterThan(0)
  })
})
