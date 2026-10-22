const $ = (id) => document.getElementById(id);
const KINDS = ["receipt", "invoice", "label", "shipping"];
let defaultServer = "";

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind || ""}`;
}

function fillPrinters(select, printers, value, kind) {
  select.replaceChildren();
  const def = printers.find((p) => p.isDefault);
  const first = document.createElement("option");
  first.value = "";
  first.textContent =
    kind === "shipping" ? "نفس طابعة الملصقات" : def ? `الطابعة الافتراضية (${def.displayName})` : "الطابعة الافتراضية لويندوز";
  select.appendChild(first);
  for (const p of printers) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.displayName;
    select.appendChild(o);
  }
  // طابعة محفوظة لم تعد موجودة (مفصولة مثلاً): نبقيها ظاهرة حتى لا تضيع
  if (value && !printers.some((p) => p.name === value)) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = `${value} (غير متصلة)`;
    select.appendChild(o);
  }
  select.value = value || "";
}

function collect() {
  return {
    serverUrl: $("serverUrl").value.trim(),
    startPage: $("startPage").value,
    silentPrint: $("silentPrint").checked,
    printers: Object.fromEntries(KINDS.map((k) => [k, $(`printer-${k}`).value])),
    receiptCopies: Number($("receiptCopies").value) || 1,
    usePrinterPaper: $("usePrinterPaper").checked,
    openAtLogin: $("openAtLogin").checked,
    fullscreenOnStart: $("fullscreenOnStart").checked,
  };
}

async function load() {
  const data = await window.settingsApi.get();
  if (!data) return;
  const c = data.config;
  defaultServer = data.defaultServer;
  $("version").textContent = data.version;
  $("serverUrl").value = c.serverUrl;
  $("startPage").value = c.startPage;
  $("silentPrint").checked = !!c.silentPrint;
  $("receiptCopies").value = c.receiptCopies;
  $("usePrinterPaper").checked = !!c.usePrinterPaper;
  $("openAtLogin").checked = !!c.openAtLogin;
  $("fullscreenOnStart").checked = !!c.fullscreenOnStart;
  for (const k of KINDS) fillPrinters($(`printer-${k}`), data.printers, c.printers[k], k);
  if (!data.printers.length) setStatus("لا توجد طابعات مثبتة على هذا الجهاز", "warn");
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("جارٍ الحفظ...");
  const res = await window.settingsApi.save(collect());
  setStatus(res.ok ? "تم الحفظ ✓" : res.error, res.ok ? "ok" : "err");
});

for (const btn of document.querySelectorAll("[data-test]")) {
  btn.addEventListener("click", async () => {
    const kind = btn.dataset.test;
    // نحفظ أولاً حتى تُستخدم الطابعة المختارة
    const saved = await window.settingsApi.save(collect());
    if (!saved.ok) return setStatus(saved.error, "err");
    setStatus("جارٍ إرسال الطباعة التجريبية...");
    const res = await window.settingsApi.testPrint(kind);
    if (res.canceled) return setStatus("");
    setStatus(res.ok ? "تم إرسال الطباعة التجريبية ✓" : `تعذرت الطباعة: ${res.error}`, res.ok ? "ok" : "err");
  });
}

$("resetServer").addEventListener("click", () => {
  $("serverUrl").value = defaultServer;
});
$("close").addEventListener("click", () => window.close());

load();
