// A real game in a real browser: an admin laptop, three phones and the results page.
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { Admin, BASE, refuseLiveGame, sleep } from "./lib";

const SHOTS = "docs/reports/screens";
const failures: string[] = [];

function check(what: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "ok    " : "FAILED"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!passed) failures.push(what);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function noSideScroll(page: Page, where: string): Promise<void> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(`No sideways scrolling: ${where}`, !wide);
}

async function main() {
  refuseLiveGame();
  mkdirSync(SHOTS, { recursive: true });
  const api = new Admin();
  await api.login();
  await api.json("POST", "/new-game", { confirm: "NEW GAME" });

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (page: Page, who: string) => {
    page.on("pageerror", (error) => errors.push(`${who}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("401") && !message.text().includes("400")) errors.push(`${who}: ${message.text()}`);
    });
  };

  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const admin = await adminContext.newPage();
  watch(admin, "admin");
  await admin.goto(`${BASE}/admin`);
  await admin.getByLabel("Passcode").fill(process.env.ADMIN_PASSCODE!);
  await admin.getByRole("button", { name: "Log in" }).click();
  await admin.getByRole("heading", { name: "Fake It Till U Make It admin" }).waitFor();

  await admin.getByRole("tab", { name: /Teams/ }).click();
  await admin.getByLabel("How many team codes").fill("3");
  await admin.getByRole("button", { name: "Make codes" }).click();
  await admin.locator("td.mono").nth(2).waitFor();
  const codes = await admin.locator("td.mono").allTextContents();
  check("Admin makes 3 team codes", codes.length === 3);
  await shot(admin, "admin-teams");

  const cards = await adminContext.newPage();
  await cards.goto(`${BASE}/admin/cards`);
  await cards.locator(".card svg").first().waitFor();
  check("Player cards show a QR and code", (await cards.locator(".card").count()) === 3 && (await cards.textContent(".card .mono")) !== "");
  await shot(cards, "player-cards");
  await cards.close();

  const phones: Page[] = [];
  for (let i = 0; i < 3; i += 1) {
    const context = await browser.newContext({ viewport: { width: 360, height: 700 }, hasTouch: true, isMobile: true });
    const phone = await context.newPage();
    watch(phone, `phone${i}`);
    await phone.goto(BASE);
    phones.push(phone);
  }
  await shot(phones[0], "phone-join");

  for (const [i, phone] of phones.entries()) {
    await phone.getByLabel("Crew name").fill(`<b>Crew ${i}</b>`);
    await phone.getByLabel(/Secret code/).fill(codes[i].toLowerCase());
    await phone.getByLabel(/leader/).fill(`Lead ${i}`);
    for (const n of [2, 3, 4]) await phone.getByLabel(`Participant ${n}`).fill(`Player ${n}`);
    await phone.getByRole("button", { name: "Enter the game" }).click();
    await phone.getByRole("heading", { name: "The game hasn't started yet" }).waitFor();
  }
  check("Three crews join and see the waiting screen", true);
  check("A crew name with HTML shows as plain text", (await phones[0].locator(".crew").textContent()) === "<b>Crew 0</b>");
  await shot(phones[0], "phone-waiting");
  await noSideScroll(phones[0], "waiting");

  await admin.getByRole("tab", { name: "Run game" }).click();
  await shot(admin, "admin-run");
  await admin.getByRole("button", { name: /Start Round 1: Image 1/ }).click();
  const started = Date.now();
  await Promise.all(phones.map((phone) => phone.getByRole("button", { name: /AI-generated/ }).waitFor()));
  check("Start reaches all phones", true, `${Date.now() - started} ms after the click returned`);
  const orders = await Promise.all(phones.map((phone) => phone.locator(".choices button").allTextContents()));
  check("Round 1 has four options", orders.every((order) => order.length === 4));
  await shot(phones[0], "phone-round1");
  await noSideScroll(phones[0], "round 1 question");

  await phones[0].getByRole("button", { name: /AI-generated/ }).click();
  await phones[0].getByRole("heading", { name: "Answer locked" }).waitFor();
  check("A tap locks the answer", true);
  await shot(phones[0], "phone-locked");
  await phones[0].reload();
  await phones[0].getByRole("heading", { name: "Answer locked" }).waitFor();
  check("Reloading mid-question keeps the answer locked", true);
  await phones[1].reload();
  await phones[1].getByRole("button", { name: "Real", exact: true }).waitFor();
  check("Reloading before answering brings the question back", true);
  await phones[1].getByRole("button", { name: "Real", exact: true }).click();
  await admin.getByText("2/3").waitFor();
  check("Admin sees the answer count go up", true);
  await shot(admin, "admin-running");

  // Phone 3 never answers: at zero the question must disappear.
  await phones[2].getByRole("heading", { name: "Time's up" }).waitFor({ timeout: 25000 });
  check("At zero the question disappears", (await phones[2].getByRole("button", { name: "Real", exact: true }).count()) === 0);
  await shot(phones[2], "phone-timeup");

  await admin.getByRole("tab", { name: "Questions & answers" }).click();
  await shot(admin, "admin-questions");
  await admin.getByRole("tab", { name: "Run game" }).click();

  // Round 3 and Round 4 show their text and options on the phone.
  type State = { questions: { id: string; round_number: number }[] };
  const state = await api.json<State>("GET", "/state");
  const round3 = state.questions.find((q) => q.round_number === 3)!;
  const round4 = state.questions.find((q) => q.round_number === 4)!;
  await api.json("POST", "/runs", { questionId: round3.id });
  await phones[0].getByRole("button", { name: /AI-Generated Text/ }).waitFor();
  check("Round 3 shows the text on the phone", await phones[0].getByText("Technology has changed the way people communicate").isVisible());
  await shot(phones[0], "phone-round3");
  await noSideScroll(phones[0], "round 3 question");
  await phones[0].getByRole("button", { name: /Human-Written Text/ }).click();
  // This tap races the admin's reset on purpose: the phone must not get a server error.
  await phones[1].getByRole("button", { name: /AI-Generated Text/ }).click();
  await api.json("POST", `/runs/${round3.id}/reset`);
  await api.json("POST", "/runs", { questionId: round4.id });
  await phones[0].getByRole("heading", { name: "The Mystery Hand" }).waitFor();
  check("Round 4 shows the title and 4 options", (await phones[0].locator(".choices button").count()) === 4);
  await shot(phones[0], "phone-round4");
  await noSideScroll(phones[0], "round 4 question");
  await phones[0].locator(".choices button").nth(1).click();
  await phones[0].getByRole("heading", { name: "Answer locked" }).waitFor();
  check("Admin reset of a question works and a new one starts", true);

  // Results
  const results = await adminContext.newPage();
  await results.setViewportSize({ width: 1280, height: 720 });
  await results.goto(`${BASE}/results`);
  await results.getByRole("heading", { name: "And the winners are…" }).waitFor();
  check("Results page stays hidden until published", true);
  await api.json("POST", "/publish", { published: true });
  await results.getByRole("heading", { name: "The winners", exact: true }).waitFor({ timeout: 8000 });
  await shot(results, "results");
  check("Results appear when published", (await results.locator(".podium > div").count()) === 3);
  await phones[0].getByRole("heading", { name: /You came/ }).waitFor({ timeout: 10000 });
  await shot(phones[0], "phone-final");
  check("Phones show their final place", true);

  await admin.getByRole("tab", { name: "Results" }).click();
  await admin.locator("table tbody tr").nth(2).waitFor();
  await shot(admin, "admin-results");
  await admin.getByLabel("Type NEW GAME to confirm").fill("NEW GAME");
  await admin.getByRole("button", { name: "New game", exact: true }).click();
  await phones[0].getByLabel("Crew name").waitFor({ timeout: 10000 });
  check("New game logs the old phones out", true);

  check("No errors in any browser", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
