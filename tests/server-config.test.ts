import { describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";

describe("configuração do servidor", () => {
  it("usa 0.0.0.0 como host padrão (sem SERVER_HOST definido — rede local)", () => {
    expect(process.env.SERVER_HOST).toBeUndefined();
    expect(config.serverHost).toBe("0.0.0.0");
  });
});
