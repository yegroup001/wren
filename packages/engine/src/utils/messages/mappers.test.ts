import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "src/entrypoints/agentSdkTypes.js"
import { toInternalMessages } from "./mappers.js"

describe("message mappers", () => {
  test("restores compact boundaries from SDK system messages", () => {
    const messages = toInternalMessages([
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 123,
          preserved_segment: {
            head_uuid: "head-1",
            anchor_uuid: "anchor-1",
            tail_uuid: "tail-1",
          },
        },
      } as unknown as SDKMessage,
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compactMetadata: {
        trigger: "manual",
        preTokens: 123,
        preservedSegment: {
          headUuid: "head-1",
          anchorUuid: "anchor-1",
          tailUuid: "tail-1",
        },
      },
    })
  })
})
