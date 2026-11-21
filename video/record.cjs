// Records the MandatePay demo video (silent, burned-in captions) with headless Chromium.
// Usage: node video/record.cjs <outDir>   (run from the mandatepay folder; needs playwright and network access to Aevum)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(root, "video", "out"));
fs.mkdirSync(outDir, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  });
});

const EXPLORER = "https://explorer-test.qday.info";
const PAY_TX = "0x8d0240f5de9c1e208c4ea2e3769c4a714b4557adf47103bc924a7389128845d4";
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAP_CSS = `#__cap{position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:14px 60px 18px;background:rgba(10,12,15,.92);
  color:#fff;font:22px/1.4 system-ui,"Segoe UI",sans-serif;border-top:1px solid #2a313a}#__cap:empty{display:none}`;
async function overlayCaption(page, text) {
  await page.evaluate(([css, t]) => {
    let d = document.getElementById("__cap");
    if (!d) {
      const s = document.createElement("style"); s.textContent = css; document.head.append(s);
      d = document.createElement("div"); d.id = "__cap"; document.body.append(d);
    }
    d.textContent = t;
  }, [CAP_CSS, text]);
}
async function smoothScroll(page, to, ms) {
  const from = await page.evaluate(() => scrollY);
  const steps = Math.max(1, Math.round(ms / 40));
  for (let i = 1; i <= steps; i++) {
    const y = from + ((to - from) * (1 - Math.cos((Math.PI * i) / steps))) / 2;
    await page.evaluate((v) => scrollTo(0, v), y);
    await sleep(40);
  }
}

const DEMO = [
  ["1. Owner deposits 5 tUSD8 into the vault", ["ok  approve  0x1b5a…85b9", "ok  deposit  0x1e40…585d"], "The owner funds the vault with real tUSD8 on Aevum testnet."],
  ["2. Owner issues a mandate: 1 per payment, 3 per day, review above 0.5, 7 days, one merchant", ["ok  createMandate  0xff45…3949", "mandate #1, spendable now 1 tUSD8"], "The agent gets a session key bound to these limits, not the money."],
  ["3. Agent pays invoice INV-1001 (0.4) gaslessly through a relayer", ["ok  payWithSig INV-1001  0x8d02…45d4"], "The agent only signs. A relayer pays the gas. The merchant is paid 0.4."],
  ["4. Agent times out and retries INV-1001", ["<span class='bad'>blocked</span>  retry INV-1001: RefAlreadyUsed"], "Same invoice ref twice: refused. No double payment."],
  ["5. Agent tries 1.5 in one payment", ["<span class='bad'>blocked</span>  INV-1002: OverPerTxCap"], "Above the per-payment cap: refused on-chain, whatever the agent was told."],
  ["6. Agent pays 0.9: above the review threshold", ["<span class='warn'>held</span>  INV-1003 → pending request #1 (funds reserved)", "ok  owner approvePending  0xb54f…3621"], "Large payments wait for the owner. One tap approves, and the merchant is paid."],
  ["7. Owner revokes the mandate", ["ok  revoke  0xeefb…41ba", "<span class='bad'>blocked</span>  INV-1004: MandateRevokedError"], "Revoked: the agent's very next payment fails. Merchant received 1.3 tUSD8 in total."],
];

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } }, colorScheme: "light" });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

  // Warm the console and explorer in a second tab so the recorded loads are fast.
  const warm = await ctx.newPage();
  await warm.goto(`${base}/app/`).catch(() => {});

  await page.goto(`${base}/video/slides.html`);
  await page.evaluate(() => show("title"));
  log("title"); await sleep(7000);

  await page.evaluate(() => show("problem", "Agents now buy API credits, data and compute. Today the owner must choose between risk and babysitting."));
  log("problem"); await sleep(11000);

  await page.evaluate(() => show("mandate", "MandatePay is the third option: a spending mandate enforced by a contract on QDay Aevum."));
  for (let i = 1; i <= 6; i++) { await page.evaluate((n) => reveal(n), i); await sleep(2600); }
  log("mandate"); await sleep(2500);

  await page.evaluate(() => show("arch", "The owner sets the rules once. Every agent payment is checked by the vault in a single transaction."));
  log("arch"); await sleep(11000);

  await page.evaluate(() => show("demo", "This is the real run on Aevum testnet on 2026-11-21. Every line is a transaction or an on-chain revert."));
  await sleep(2500);
  for (const [head, lines, cap] of DEMO) {
    await page.evaluate(([h, c]) => { term(`<div class="h">${h}</div>`); caption(c); }, [head, cap]);
    await sleep(1200);
    for (const l of lines) { await page.evaluate((x) => term(`<div>  ${x.replace(/^ok /, "<span class='ok'>ok</span> ")}</div>`), l); await sleep(900); }
    await sleep(3300);
  }
  log("demo"); await sleep(1500);

  // Owner console, read-only view of the live vault.
  await warm.close();
  await page.goto(`${base}/app/`);
  await overlayCaption(page, "The owner console (static page, no backend) reads the live vault on Aevum.");
  await page.waitForFunction(() => document.querySelectorAll("#actList tr td").length > 5, null, { timeout: 90000 }).catch(() => log("activity not loaded"));
  await sleep(4000);
  log("console top");
  await overlayCaption(page, "Funds and the kill switch: one click freezes every agent at once, and it is reversible.");
  await sleep(5000);
  await page.evaluate(() => document.querySelector("#mandList").scrollIntoView({ block: "start" }));
  await page.evaluate(() => scrollBy(0, -80));
  const yM = await page.evaluate(() => scrollY);
  await page.evaluate(() => scrollTo(0, 0));
  await smoothScroll(page, yM, 2500);
  await overlayCaption(page, "Each mandate shows its budget use, caps, expiry and allowed merchants. This one is revoked.");
  await sleep(6000);
  await page.click("#mandList details summary").catch(() => {});
  await overlayCaption(page, "The agent only needs this config: an EIP-712 PaymentIntent signed with its session key.");
  await sleep(6000);
  const yA = await page.evaluate(() => document.querySelector("#actList").closest("section").getBoundingClientRect().top + scrollY - 60);
  await smoothScroll(page, yA, 2500);
  await overlayCaption(page, "The activity log is rebuilt from on-chain events: deposit, mandate, payments, escalation, approval, revoke.");
  await sleep(8000);
  log("console");

  // One payment on the explorer.
  try {
    await page.goto(`${EXPLORER}/tx/${PAY_TX}`, { timeout: 30000, waitUntil: "domcontentloaded" });
    await sleep(4000);
    await overlayCaption(page, "Every step is verifiable on the Aevum explorer: here, the agent's gasless 0.4 tUSD8 payment.");
    await sleep(8000);
    log("explorer");
  } catch (e) { log(`explorer skipped: ${e.message}`); }

  await page.goto(`${base}/video/slides.html`);
  await page.evaluate(() => show("close"));
  log("close"); await sleep(9000);

  const video = page.video();
  await ctx.close();
  const src = await video.path();
  console.log("VIDEO", src);
  await browser.close();
  server.close();
});
