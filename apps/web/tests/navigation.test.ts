import { expect, it } from "vitest";
import { appReturnPath } from "../src/navigation.js";

it("returns to the notified message after login without accepting external redirects", () => {
  expect(appReturnPath("?next=%2Fapp%3Fchannel%3Dc%26message%3Dm")).toBe(
    "/app?channel=c&message=m",
  );
  expect(appReturnPath("?next=https%3A%2F%2Fevil.example")).toBe("/app");
  expect(appReturnPath("?next=%2F%2Fevil.example%2Fapp")).toBe("/app");
});
