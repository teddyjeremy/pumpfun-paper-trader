import { describe, expect, it } from "vitest";
import { isPaperWorkerPaused } from "../src/paper/trading-readiness.js";

describe("isPaperWorkerPaused", () => {
  it("only treats the exact string false as an explicit unpause", () => {
    expect(isPaperWorkerPaused("false")).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    "true",
    "TRUE",
    "False",
    "0",
    "false ",
    false
  ])("keeps an unknown pause value paused: %s", value => {
    expect(isPaperWorkerPaused(value)).toBe(true);
  });
});
