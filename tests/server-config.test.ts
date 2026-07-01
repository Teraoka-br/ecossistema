import { describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";

describe("configuração do servidor", () => {
  it("usa 127.0.0.1 como host padrão (sem SERVER_HOST definido)", () => {
    expect(process.env.SERVER_HOST).toBeUndefined();
    expect(config.serverHost).toBe("127.0.0.1");
  });
});
