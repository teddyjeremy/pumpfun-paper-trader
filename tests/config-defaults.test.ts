import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

describe("paper portfolio dashboard defaults", () => {
  it("matches the Worker initial stake and concurrency policy", () => {
    expect(config.PAPER_STARTING_BALANCE_USD).toBe(2.7);
    expect(config.PAPER_POSITION_SIZE_USD).toBe(1);
    expect(config.PAPER_MAX_OPEN_POSITIONS).toBe(1);
  });
});
