import { expect, test } from "@playwright/test";

test("shows authentication entry point", async ({page}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Войти в ежедневник"})).toBeVisible();
  await expect(page.getByRole("button", {name:"Войти"})).toBeVisible();
});
