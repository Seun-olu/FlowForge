import { expect, test, type Page } from "@playwright/test";

const run = Date.now().toString(36);
const owner = { name: "Olu Owner", email: `owner-${run}@example.test`, password: "password-123" };
const approver = { name: "Ada Approver", email: `approver-${run}@example.test`, password: "password-456" };

async function signUp(page: Page, u: typeof owner) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(u.name);
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(u.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
}

async function signIn(page: Page, u: typeof owner) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(u.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/o\//);
}

async function startRun(page: Page, input: string) {
  await page.getByLabel("Input (JSON)").fill(input);
  await page.getByRole("button", { name: "Run published version" }).click();
  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]+$/);
}

test.describe.serial("FlowForge core journeys", () => {
  let orgUrl = "";
  let workflowUrl = "";

  test("unauthenticated users are sent to login", async ({ page }) => {
    await page.goto("/orgs");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Email").fill("nobody@example.test");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email or password is incorrect", { exact: true })).toBeVisible();
  });

  test("owner builds, validates and publishes a workflow, then runs the auto branch", async ({ page }) => {
    await signUp(page, approver); // second account, added to the org later
    await page.context().clearCookies();
    await signUp(page, owner);
    await page.getByLabel("New organization name").fill("Acme Ops");
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page.getByTestId("role")).toHaveText("owner");
    orgUrl = new URL(page.url()).pathname;

    // Blank workflow: the editor validates live.
    await page.getByLabel("Name").fill("Scratch");
    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page.getByTestId("valid")).toBeVisible();
    await page.getByRole("button", { name: "+ condition" }).click();
    await expect(page.getByTestId("issues")).toContainText('needs one "true" and one "false" connection');
    await expect(page.getByTestId("issues")).toContainText("not reachable from Start");
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Delete node" }).click();
    await expect(page.getByTestId("valid")).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published version 1", { exact: true })).toBeVisible();

    // Sample purchase approval workflow.
    await page.goto(orgUrl);
    await page.getByLabel("Name").fill("Purchase approval");
    await page.getByLabel("Start from").selectOption("purchase");
    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page.getByTestId("publish-state")).toHaveText("Not published");
    await expect(page.getByText("Publish a valid version to run it.")).toBeVisible();

    // Edit config: change the condition threshold, publish v1.
    await page.getByTestId("node-check").click();
    await page.getByLabel("Expression").fill("input.amount > 500");
    await expect(page.getByTestId("publish-state")).toContainText("unsaved changes");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published version 1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("versions")).toContainText("v1 (live)");
    workflowUrl = new URL(page.url()).pathname;

    await startRun(page, '{"amount": 120}');
    await expect(page.getByTestId("execution-status")).toHaveText("succeeded");
    await expect(page.getByTestId("steps")).toContainText("Auto-approve");
    await expect(page.getByTestId("steps")).not.toContainText("Manager approval");
    await expect(page.getByText('"approved_by": "policy"')).toBeVisible();
    await expect(page.getByTestId("logs")).toContainText("Condition evaluated to false");
  });

  test("approver approves from the inbox; viewer-level rights are enforced", async ({ page }) => {
    await signIn(page, owner);
    await page.goto(`${orgUrl}/members`);
    await page.getByLabel("Email of an existing account").fill(approver.email);
    await page.getByLabel("Role", { exact: true }).selectOption("approver");
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText("Member added")).toBeVisible();

    await page.goto(workflowUrl);
    await startRun(page, '{"amount": 9000}');
    await expect(page.getByTestId("execution-status")).toHaveText("waiting approval");
    const approvalRun = page.url();

    await page.context().clearCookies();
    await signIn(page, approver);
    await expect(page.getByTestId("role")).toHaveText("approver");
    await page.goto(`${orgUrl}/inbox`);
    const card = page.getByTestId("pending-approvals").locator("li").first();
    await expect(card).toContainText("Manager approval");
    await expect(card).toContainText('"amount":9000');
    await card.getByLabel("Comment").fill("Within budget");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Nothing waiting for approval.")).toBeVisible();

    await page.goto(approvalRun);
    await expect(page.getByTestId("execution-status")).toHaveText("succeeded");
    await expect(page.getByTestId("steps")).toContainText("approved by Ada Approver — “Within budget”");
    // Approvers cannot run or edit workflows.
    await page.goto(workflowUrl);
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run published version" })).toHaveCount(0);
  });

  test("rejection, cancel, retries, history and audit", async ({ page }) => {
    await signIn(page, owner);
    await page.goto(workflowUrl);
    await startRun(page, '{"amount": 7000}');
    await page.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByTestId("execution-status")).toHaveText("failed");
    await expect(page.getByTestId("steps")).toContainText("Denied");

    await page.goto(workflowUrl);
    await startRun(page, '{"amount": 7001}');
    await page.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByTestId("execution-status")).toHaveText("cancelled");

    // Flaky action: fails twice, retried with 200ms backoff, then succeeds.
    await page.goto(workflowUrl);
    await page.getByTestId("node-notify").click();
    await page.getByLabel("Action", { exact: true }).selectOption("simulated_flaky");
    await page.getByLabel("Fail the first N attempts").fill("2");
    await page.getByLabel("Backoff ms").fill("200");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published version 2", { exact: true })).toBeVisible();
    await startRun(page, '{"amount": 10}');
    await expect(page.getByTestId("execution-status")).toHaveText("succeeded");
    await expect(page.getByTestId("steps")).toContainText("attempt 3/3");
    await expect(page.getByTestId("logs")).toContainText("Attempt 2 failed: Simulated failure 2 of 2; retrying in 400ms");

    // Idempotency: same key → same run.
    await page.goto(workflowUrl);
    await page.getByLabel("Idempotency key (optional)").fill("po-77");
    await startRun(page, '{"amount": 1}');
    const first = page.url();
    await page.goto(workflowUrl);
    await page.getByLabel("Idempotency key (optional)").fill("po-77");
    await startRun(page, '{"amount": 1}');
    expect(page.url()).toBe(first);

    await page.goto(`${orgUrl}/executions?status=failed`);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.goto(`${orgUrl}/executions`);
    await expect(page.locator("tbody tr")).toHaveCount(6);

    await page.goto(`${orgUrl}/audit`);
    for (const action of ["org.created", "workflow.published", "member.insert", "approval.approved", "approval.rejected", "execution.cancelled"]) {
      await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
    }
  });
});
