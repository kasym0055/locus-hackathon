import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const vercelConfigUrl = new URL("../../vercel.json", import.meta.url);

describe("Vercel deployment configuration", () => {
  it("enables request cancellation only for the capability route", () => {
    const config = existsSync(vercelConfigUrl)
      ? JSON.parse(readFileSync(vercelConfigUrl, "utf8"))
      : null;

    expect(config).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      functions: {
        "src/app/api/capability/route.ts": {
          supportsCancellation: true,
        },
      },
    });
  });
});
