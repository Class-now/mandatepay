// MandatePay owner console. Plain ES module, no build step except the vendored viem bundle.
import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseUnits, formatUnits,
  toHex, hexToString, getAddress, isAddress, parseEventLogs, BaseError, ContractFunctionRevertedError,
  privateKeyToAccount, generatePrivateKey,
} from "./vendor/viem.js";
import { vaultAbi, erc20Abi } from "./abi.js";
import { AEVUM, DEFAULTS } from "./config.js";

const DEC = 6;
const MAX128 = (1n << 128n) - 1n;
const SCAN_BLOCKS = 5000n; // Aevum limits eth_getLogs to 1,000 blocks per call; we page through.
const LIST_LIMIT = 200n;
const STATUS = ["None", "Waiting", "Approved", "Rejected", "Expired"];

const params = new URLSearchParams(location.search);
const rpcUrl = params.get("rpc") || AEVUM.rpc;
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(rpcUrl);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v) => Number(formatUnits(v, DEC)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const usd = (s) => {
  const v = String(s ?? "").trim();
  if (!v || Number(v) < 0) throw new Error("Enter an amount.");
  return parseUnits(v, DEC);
};
const labelOf = (b) => hexToString(b).replace(/\u0000+$/g, "") || "(no label)";
const dur = (sec) => {
  sec = Number(sec);
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const periodName = (p) => ({ 3600: "hour", 86400: "day", 604800: "week", 2592000: "30 days" })[Number(p)] ?? `${dur(p)}`;

const FRIENDLY = {
  NotOwner: "Only the mandate's owner can do that.",
  NotAgent: "Only the mandate's agent key can pay directly.",
  UnknownMandate: "No such mandate.",
  MandateRevokedError: "This mandate is revoked.",
  MandateExpired: "Expired.",
  OwnerIsFrozen: "Your agents are frozen.",
  MerchantNotAllowed: "Merchant is not on the allow-list.",
  OverPerTxCap: "Above the per-payment cap.",
  OverBudget: "Over the budget for this window.",
  RefAlreadyUsed: "This reference was already paid.",
  InsufficientBalance: "Not enough free balance in the vault.",
  BadParams: "Check the values: cap must be > 0 and ≤ budget, expiry in the future, agent ≠ you.",
  NotWaiting: "Already answered.",
  ReviewWindowOpen: "The review window is still open.",
};

let chain, publicClient, walletClient, account, me, vault, token;
const state = { mandates: new Map(), pendings: new Map(), merchants: new Map() };

// ---------------------------------------------------------------- toasts
function toast(html, bad = false, ms = 6000) {
  const d = document.createElement("div");
  if (bad) d.className = "bad";
  d.innerHTML = html;
  $("toast").append(d);
  setTimeout(() => d.remove(), ms);
  return d;
}
const txLink = (h) =>
  chain.id === AEVUM.id ? `<a href="${AEVUM.explorer}/tx/${h}" target="_blank" rel="noopener" class="mono">${short(h)}</a>` : `<span class="mono">${short(h)}</span>`;

function explain(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = r?.data?.errorName;
    if (name) return FRIENDLY[name] ?? name;
    return e.shortMessage;
  }
  return e?.message ?? String(e);
}

// --------------------------------------------------------------- connect
async function setup() {
  chain =
    rpcUrl === AEVUM.rpc
      ? defineChain({ id: AEVUM.id, name: AEVUM.name, nativeCurrency: AEVUM.currency, rpcUrls: { default: { http: [AEVUM.rpc] } }, blockExplorers: { default: { name: "Explorer", url: AEVUM.explorer } } })
      : null;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  if (!chain) {
    const id = await probe.getChainId();
    chain = defineChain({ id, name: isLocal ? "Local chain" : `Chain ${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  }
  publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  $("net").textContent = `${chain.name} · ${chain.id}`;
  $("vaultAddr").value = params.get("vault") || localStorageGet("vault") || DEFAULTS.vault;
  $("tokenAddr").value = params.get("token") || DEFAULTS.token;
  $("devkey").hidden = !isLocal;
}

function localStorageGet(k) {
  try { return localStorage.getItem(`mandatepay.${k}`); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(`mandatepay.${k}`, v); } catch {}
}

async function connectInjected() {
  const eth = window.ethereum;
  if (!eth) {
    toast(isLocal ? "No browser wallet found. On a local chain you can paste a Hardhat test key below." : "Install a browser wallet (MetaMask, Rabby…) to continue.", true);
    return;
  }
  const [addr] = await eth.request({ method: "eth_requestAccounts" });
  const hexId = toHex(chain.id);
  if ((await eth.request({ method: "eth_chainId" })) !== hexId) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (err) {
      if (err?.code !== 4902 || chain.id !== AEVUM.id) throw err;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: AEVUM.name, nativeCurrency: AEVUM.currency, rpcUrls: [AEVUM.rpc], blockExplorerUrls: [AEVUM.explorer] }],
      });
    }
  }
  walletClient = createWalletClient({ chain, transport: custom(eth) });
  account = getAddress(addr);
  me = account;
  eth.on?.("accountsChanged", () => location.reload());
  eth.on?.("chainChanged", () => location.reload());
  connected();
}

function useDevKey() {
  const k = $("devKeyInput").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return toast("That is not a private key.", true);
  account = privateKeyToAccount(k);
  me = account.address;
  walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
  $("devKeyInput").value = "";
  connected();
}

function connected() {
  $("who").textContent = short(me);
  $("connect").textContent = "Connected";
  $("connect").disabled = true;
  loadVault();
}

function loadVault() {
  const v = $("vaultAddr").value.trim(), t = $("tokenAddr").value.trim();
  if (!isAddress(v) || !isAddress(t)) return toast("Enter the vault and token addresses.", true);
  vault = getAddress(v);
  token = getAddress(t);
  localStorageSet("vault", vault);
  refresh();
}

// ----------------------------------------------------------------- writes
const read = (functionName, args = [], address = vault, abi = vaultAbi) =>
  publicClient.readContract({ address, abi, functionName, args });

async function send(functionName, args, { address = vault, abi = vaultAbi, what = functionName } = {}) {
  if (!walletClient) return toast("Connect a wallet first.", true);
  const note = toast(`${esc(what)}: waiting for signature…`, false, 60000);
  try {
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account });
    const hash = await walletClient.writeContract(request);
    note.innerHTML = `${esc(what)}: sent ${txLink(hash)}`;
    const r = await publicClient.waitForTransactionReceipt({ hash });
    note.remove();
    toast(`${r.status === "success" ? "✓" : "✗"} ${esc(what)} ${txLink(hash)}`, r.status !== "success");
    await refresh();
    return r;
  } catch (e) {
    note.remove();
    toast(`${esc(what)}: ${esc(explain(e))}`, true, 9000);
  }
}

async function deposit() {
  const amount = usd($("amt").value);
  const allowance = await read("allowance", [me, vault], token, erc20Abi);
  if (allowance < amount) {
    const r = await send("approve", [vault, amount], { address: token, abi: erc20Abi, what: "Approve tUSD8" });
    if (!r) return;
  }
  await send("deposit", [amount], { what: `Deposit ${fmt(amount)}` });
}

async function createMandate() {
  const agent = $("mAgent").value.trim();
  if (!isAddress(agent)) return toast("Enter the agent's address or make a new session key.", true);
  const merchants = $("mMerchants").value.split(/[\s,]+/).filter(Boolean);
  const badM = merchants.find((m) => !isAddress(m));
  if (badM) return toast(`Not an address: ${esc(badM)}`, true);
  const review = $("mReview").value.trim();
  const now = BigInt((await publicClient.getBlock()).timestamp);
  const label = $("mLabel").value.trim().slice(0, 31);
  await send(
    "createMandate",
    [
      getAddress(agent),
      usd($("mCap").value),
      usd($("mBudget").value),
      BigInt($("mPeriod").value),
      now + BigInt(Math.max(1, Number($("mDays").value))) * 86400n,
      review === "" ? MAX128 : usd(review),
      toHex(label, { size: 32 }),
      merchants.map(getAddress),
    ],
    { what: `Issue mandate “${label}”` },
  );
}

function newSessionKey() {
  const pk = generatePrivateKey();
  const addr = privateKeyToAccount(pk).address;
  $("mAgent").value = addr;
  const out = $("keyOut");
  out.hidden = false;
  out.innerHTML = `<div style="font-size:13px">Give this key to the agent (for example as <span class="mono">AGENT_KEY</span>). It can only ask the vault to pay inside the mandate, and needs no gas. It is shown once and never stored.</div><div class="mono" id="keyValue" style="margin-top:6px">${pk}</div>`;
}

// ----------------------------------------------------------------- reads
async function inChunks(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}
const idsDown = (count) => {
  const ids = [];
  for (let i = count; i >= 1n && count - i < LIST_LIMIT; i--) ids.push(i);
  return ids;
};

async function refresh() {
  if (!vault || !me) return;
  try {
    const [wallet, free, held, frozen, mCount, pCount, block] = await Promise.all([
      read("balanceOf", [me], token, erc20Abi),
      read("balanceOf", [me]),
      read("heldOf", [me]),
      read("frozen", [me]),
      read("mandateCount"),
      read("pendingCount"),
      publicClient.getBlock(),
    ]);
    state.now = block.timestamp;
    state.frozen = frozen;
    $("sWallet").textContent = fmt(wallet);
    $("sFree").textContent = fmt(free);
    $("sHeld").textContent = fmt(held);
    $("freeze").textContent = frozen ? "Unfreeze agents" : "Freeze all agents";
    $("freeze").className = frozen ? "primary" : "danger";

    state.mandates.clear();
    const ms = await inChunks(idsDown(mCount), 20, async (id) => [id, await read("getMandate", [id])]);
    for (const [id, m] of ms) if (m.owner === me) state.mandates.set(id, m);
    const spend = await inChunks([...state.mandates.keys()], 20, async (id) => [id, await read("spendableNow", [id])]);
    for (const [id, s] of spend) state.mandates.get(id).spendable = s;

    state.pendings.clear();
    const ps = await inChunks(idsDown(pCount), 20, async (id) => [id, await read("getPending", [id])]);
    for (const [id, p] of ps) if (state.mandates.has(p.mandateId)) state.pendings.set(id, p);

    await scanActivity(block.number);
    render();
  } catch (e) {
    toast(`Could not read the vault: ${esc(explain(e))}`, true, 9000);
  }
}

async function scanActivity(latest) {
  const from = latest > SCAN_BLOCKS ? latest - SCAN_BLOCKS : 0n;
  const logs = [];
  for (let start = from; start <= latest; start += 1000n) {
    const end = start + 999n > latest ? latest : start + 999n;
    logs.push(...(await publicClient.getLogs({ address: vault, fromBlock: start, toBlock: end })));
  }
  const events = parseEventLogs({ abi: vaultAbi, logs });
  state.merchants.clear();
  state.activity = [];
  for (const ev of events) {
    const a = ev.args;
    const mid = a.mandateId ?? (a.pendingId !== undefined ? state.pendings.get(a.pendingId)?.mandateId : undefined);
    const mine = (a.owner && a.owner === me) || (mid !== undefined && state.mandates.has(mid));
    if (!mine) continue;
    if (ev.eventName === "MerchantSet") {
      const set = state.merchants.get(a.mandateId) ?? new Set();
      a.allowed ? set.add(a.merchant) : set.delete(a.merchant);
      state.merchants.set(a.mandateId, set);
    }
    state.activity.push({ ev, mid });
  }
  state.activity.reverse();
}

// ---------------------------------------------------------------- render
function statusOf(m) {
  if (m.revoked) return ["revoked", "bad"];
  if (state.now >= m.expiresAt) return ["expired", "bad"];
  if (state.frozen) return ["frozen", "warn"];
  return ["active", "ok"];
}

function render() {
  // pending
  const waiting = [...state.pendings.entries()].filter(([, p]) => p.status === 1);
  $("pendCount").textContent = waiting.length;
  $("pendList").innerHTML = waiting.length
    ? waiting
        .map(([id, p]) => {
          const m = state.mandates.get(p.mandateId);
          const left = p.expiresAt - state.now;
          return `<div class="pending">
            <div><strong>${fmt(p.amount)} tUSD8</strong> to <span class="mono">${short(p.merchant)}</span>
              from <strong>${esc(labelOf(m.label))}</strong> <span class="muted">(mandate #${p.mandateId}, request #${id})</span></div>
            <div class="muted" style="font-size:13px">ref <span class="mono">${short(p.ref)}</span> ·
              ${left > 0n ? `returns to you automatically in ${dur(left)} if you do nothing` : "review window over: anyone can return the funds"}</div>
            <div class="actions">
              ${left > 0n ? `<button class="primary" data-act="approve" data-id="${id}">Approve and pay</button><button class="danger" data-act="reject" data-id="${id}">Reject</button>` : `<button data-act="expire" data-id="${id}">Return funds</button>`}
            </div></div>`;
        })
        .join("")
    : `<div class="empty">Nothing to review.</div>`;

  // mandates
  $("mandCount").textContent = state.mandates.size;
  $("mandList").innerHTML = state.mandates.size
    ? [...state.mandates.entries()].map(([id, m]) => mandateCard(id, m)).join("")
    : `<div class="empty">No mandates yet. Issue one above.</div>`;

  // activity
  $("actList").innerHTML = state.activity.length
    ? state.activity.slice(0, 60).map(({ ev, mid }) => `<tr><td>${ev.blockNumber}</td><td>${esc(ev.eventName)}</td><td>${mid !== undefined ? `#${mid}` : ""}</td><td>${esc(detail(ev))}</td><td>${txLink(ev.transactionHash)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No activity in the last ${SCAN_BLOCKS} blocks.</td></tr>`;
}

function detail(ev) {
  const a = ev.args;
  switch (ev.eventName) {
    case "Deposited": return `+${fmt(a.amount)}`;
    case "Withdrawn": return `−${fmt(a.amount)} to ${short(a.to)}`;
    case "MandateCreated": return `“${labelOf(a.label)}” agent ${short(a.agent)}, ${fmt(a.perTxCap)}/payment, ${fmt(a.budget)}/${periodName(a.period)}`;
    case "MandateLimitsUpdated": return `${fmt(a.perTxCap)}/payment, ${fmt(a.budget)} budget`;
    case "MerchantSet": return `${short(a.merchant)} ${a.allowed ? "allowed" : "removed"}`;
    case "MandateRevoked": return "revoked";
    case "OwnerFrozen": return a.frozen ? "all agents frozen" : "agents unfrozen";
    case "Paid": return `${fmt(a.amount)} to ${short(a.merchant)}${a.pendingId ? ` (approved request #${a.pendingId})` : ""}`;
    case "PaymentEscalated": return `${fmt(a.amount)} to ${short(a.merchant)} held for review (#${a.pendingId})`;
    case "EscalationResolved": return `request #${a.pendingId} ${STATUS[a.status].toLowerCase()}`;
    default: return "";
  }
}

function mandateCard(id, m) {
  const [st, cls] = statusOf(m);
  const pct = m.budget ? Number((m.spent * 1000n) / m.budget) / 10 : 0;
  const merchants = m.anyMerchant ? "any merchant" : [...(state.merchants.get(id) ?? [])].map(short).join(", ") || "allow-list";
  const live = st === "active" || st === "frozen";
  const cfg = {
    chainId: chain.id, vault, mandateId: id.toString(), agent: m.agent,
    submit: "payWithSig(mandateId, merchant, amount, ref, deadline, signature)",
    eip712: { domain: { name: "MandateVault", version: "1", chainId: chain.id, verifyingContract: vault },
      primaryType: "PaymentIntent",
      types: { PaymentIntent: [["mandateId", "uint256"], ["merchant", "address"], ["amount", "uint256"], ["ref", "bytes32"], ["deadline", "uint256"]].map(([name, type]) => ({ name, type })) } },
  };
  return `<div class="mandate" data-id="${id}">
    <div class="top"><strong>${esc(labelOf(m.label))}</strong><span class="badge ${cls}">${st}</span>
      <span class="muted mono">#${id} · agent ${short(m.agent)}</span></div>
    <div class="bar" title="${pct}% of this window's budget"><i style="width:${Math.min(100, pct)}%"></i></div>
    <div class="muted" style="font-size:13px">${fmt(m.spent)} of ${fmt(m.budget)} used this ${periodName(m.period)} · resets in ${dur(m.periodStart + m.period - state.now)}</div>
    <div class="kv">
      <div><span>Per payment</span><br>${fmt(m.perTxCap)}</div>
      <div><span>Ask me above</span><br>${m.reviewAbove === MAX128 ? "never" : fmt(m.reviewAbove)}</div>
      <div><span>Can pay now</span><br>${fmt(m.spendable)}</div>
      <div><span>${state.now >= m.expiresAt ? "Expired" : "Expires in"}</span><br>${state.now >= m.expiresAt ? new Date(Number(m.expiresAt) * 1000).toLocaleDateString() : dur(m.expiresAt - state.now)}</div>
      <div><span>Merchants</span><br>${esc(merchants)}</div>
    </div>
    ${live ? `<div class="actions">
      <button class="danger" data-act="revoke" data-id="${id}">Revoke now</button>
      <button data-act="edit" data-id="${id}">Change limits</button>
      <button data-act="merchant" data-id="${id}">Merchants</button>
    </div>
    <div class="editbox" id="edit-${id}" hidden>
      <div class="row">
        <div><label>Max per payment</label><input data-f="cap" type="number" step="0.01" value="${formatUnits(m.perTxCap, DEC)}"></div>
        <div><label>Budget per window</label><input data-f="budget" type="number" step="0.01" value="${formatUnits(m.budget, DEC)}"></div>
        <div><label>Ask me above (empty = never)</label><input data-f="review" type="number" step="0.01" value="${m.reviewAbove === MAX128 ? "" : formatUnits(m.reviewAbove, DEC)}"></div>
        <div><label>Expires in (days from now)</label><input data-f="days" type="number" step="1" min="1" value="${Math.max(1, Math.ceil(Number(m.expiresAt - state.now) / 86400))}"></div>
        <div style="flex:0 0 auto"><button class="primary" data-act="saveLimits" data-id="${id}">Save</button></div>
      </div></div>
    <div class="editbox" id="merch-${id}" hidden>
      <div class="row"><div><label>Merchant address</label><input data-f="merchant" class="mono" placeholder="0x…"></div>
        <div style="flex:0 0 auto"><button data-act="allow" data-id="${id}">Allow</button></div>
        <div style="flex:0 0 auto"><button data-act="disallow" data-id="${id}">Remove</button></div></div></div>` : ""}
    <details style="margin-top:8px"><summary>Agent configuration</summary><pre class="mono key" style="white-space:pre-wrap">${esc(JSON.stringify(cfg, null, 2))}</pre></details>
  </div>`;
}

// ---------------------------------------------------------------- events
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = BigInt(b.dataset.id);
  const card = b.closest(".mandate");
  const field = (f) => card?.querySelector(`[data-f="${f}"]`)?.value.trim() ?? "";
  try {
    switch (b.dataset.act) {
      case "approve": return await send("approvePending", [id], { what: `Approve request #${id}` });
      case "reject": return await send("rejectPending", [id], { what: `Reject request #${id}` });
      case "expire": return await send("expirePending", [id], { what: `Return funds of request #${id}` });
      case "revoke":
        if (!confirm(`Revoke mandate #${id}? The agent's key stops working in the next block. This cannot be undone.`)) return;
        return await send("revoke", [id], { what: `Revoke mandate #${id}` });
      case "edit": $(`edit-${id}`).hidden = !$(`edit-${id}`).hidden; return;
      case "merchant": $(`merch-${id}`).hidden = !$(`merch-${id}`).hidden; return;
      case "saveLimits": {
        const now = BigInt((await publicClient.getBlock()).timestamp);
        const review = field("review");
        return await send("updateLimits", [id, usd(field("cap")), usd(field("budget")), review === "" ? MAX128 : usd(review), now + BigInt(Math.max(1, Number(field("days")))) * 86400n], { what: `Update mandate #${id}` });
      }
      case "allow":
      case "disallow": {
        const addr = field("merchant");
        if (!isAddress(addr)) return toast("Enter a merchant address.", true);
        const allow = b.dataset.act === "allow";
        return await send("setMerchant", [id, getAddress(addr), allow], { what: `${allow ? "Allow" : "Remove"} merchant ${short(addr)}` });
      }
    }
  } catch (err) {
    toast(esc(explain(err)), true);
  }
});

const guard = (fn) => async () => { try { await fn(); } catch (e) { toast(esc(explain(e)), true); } };
$("connect").onclick = guard(connectInjected);
$("useDevKey").onclick = guard(useDevKey);
$("load").onclick = guard(loadVault);
$("deposit").onclick = guard(deposit);
$("withdraw").onclick = guard(() => send("withdraw", [usd($("amt").value), me], { what: `Withdraw ${$("amt").value}` }));
$("freeze").onclick = guard(() => send("setFrozen", [!state.frozen], { what: state.frozen ? "Unfreeze agents" : "Freeze all agents" }));
$("create").onclick = guard(createMandate);
$("genKey").onclick = newSessionKey;

setup().catch((e) => toast(`Cannot reach ${esc(rpcUrl)}: ${esc(explain(e))}`, true, 15000));
setInterval(() => document.visibilityState === "visible" && refresh(), 15000);
