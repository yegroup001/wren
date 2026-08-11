import { expect, test } from "bun:test"
import { filterSlashCommands, isExactSlashCommand } from "./prompt-autocomplete"

test("lists /sessions in slash command autocomplete", () => {
  expect(filterSlashCommands("/sessions")).toContainEqual({
    display: "/sessions",
    description: "Browse and resume sessions",
    value: "/sessions ",
  })
  expect(isExactSlashCommand("/sessions")).toBe(true)
})
