import { describe, it, expect } from "vitest";
import { createItAdministrator } from "../src/services/sysAdminDevOpsService.js";

// IT administrators used to fall back to one shared default password that was
// committed to a public repository. Creation must now refuse to guess, and the
// refusal happens before anything touches the database.
describe("createItAdministrator password", () => {
  it("refuses an account with no password", async () => {
    await expect(createItAdministrator({ username: "new_it_admin" })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a password the sysadmin policy rejects", async () => {
    await expect(
      createItAdministrator({ username: "new_it_admin", password: "short1A!" })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/12 characters/) });
  });
});
