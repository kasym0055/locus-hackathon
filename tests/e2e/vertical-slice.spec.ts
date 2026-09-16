import { expect, test } from "@playwright/test";
test("fixture pipeline displays a loaded image, source, score and partial final state", async ({ page, request }) => {
  test.skip(!!process.env.LIVE_BASE_URL, "Fixture acceptance is separate from live smoke");
  const raster = await (await request.get("/fixture-raster")).body();
  await page.route("https://example.edu/campus.png", route => route.fulfill({ contentType: "image/png", body: raster }));
  await page.goto("/");
  await page.getByLabel("Search universities").fill("Example University");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const photo = page.getByRole("img", { name: "campus at the selected university" });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Publisher source", exact: true })).toHaveAttribute("href", "https://example.edu/");
  await expect(page.getByText("80/100 — verified", { exact: false })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Partial profile");
});
test("failed remote delivery becomes an honest missing image", async ({ page }) => {
  test.skip(!!process.env.LIVE_BASE_URL, "Fixture acceptance is separate from live smoke");
  await page.route("https://example.edu/campus.png", route => route.abort());
  await page.goto("/"); await page.getByLabel("Search universities").fill("Example University");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Image unavailable", { exact: false })).toBeVisible();
  await expect(page.getByRole("main").getByRole("img")).toHaveCount(0);
});
test("opt-in live smoke without response substitution", async ({ page }) => {
  test.skip(!process.env.LIVE_BASE_URL || !process.env.LIVE_UNIVERSITY_QUERY, "Requires configured deployed service and operator-supplied live query");
  await page.goto("/"); await page.getByLabel("Search universities").fill(process.env.LIVE_UNIVERSITY_QUERY!);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const photo = page.getByRole("main").getByRole("img").first(); await expect(photo).toBeVisible({ timeout: 30000 });
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText(/\d+\/100 — verified/).first()).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Partial profile");
});

test("cancel stops an active request and Retry starts one explicit new request", async ({ page, request }) => {
  test.skip(!!process.env.LIVE_BASE_URL, "Fixture acceptance is separate from live smoke");
  const raster = await (await request.get("/fixture-raster")).body();
  await page.route("https://example.edu/campus.png", route => route.fulfill({ contentType: "image/png", body: raster }));
  await request.post("/fixture-mode", { data: "hang" });
  try {
    await page.goto("/"); await page.getByLabel("Search universities").fill("Example University");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Assessing");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Cancelled");
    await request.post("/fixture-mode", { data: "normal" });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("main").getByRole("img")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Partial profile");
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  } finally { await request.post("/fixture-mode", { data: "normal" }); }
});
