// إعدادات تطبيق سطح المكتب (تُحفظ في مجلد بيانات المستخدم كملف JSON)
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULT_SERVER = "https://tajer-pro-iota.vercel.app";

const DEFAULTS = {
  serverUrl: DEFAULT_SERVER,
  startPage: "dashboard", // dashboard | pos
  silentPrint: true, // طباعة مباشرة بدون نافذة اختيار الطابعة
  printers: { receipt: "", invoice: "", label: "", shipping: "" }, // "" = الطابعة الافتراضية (ملصقات الشحن: طابعة الملصقات)
  receiptCopies: 1,
  usePrinterPaper: false, // استخدام مقاس الورق المضبوط في تعريف الطابعة بدل المقاس المحسوب
  fullscreenOnStart: false,
  openAtLogin: false,
  zoom: 1,
  bounds: null,
  maximized: true,
};

let cache = null;

function file() {
  return path.join(app.getPath("userData"), "settings.json");
}

/** عناوين الشبكة المحلية (سيرفر داخل المحل) — يُسمح لها بـ http، وغيرها يجب أن يكون https */
function isLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function normalizeServerUrl(value) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw new Error("رابط النظام غير صالح");
  }
  if (u.protocol === "http:" && !isLocalHost(u.hostname)) throw new Error("الرابط يجب أن يبدأ بـ https:// (يُسمح بـ http فقط لسيرفر داخل الشبكة المحلية)");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("الرابط يجب أن يبدأ بـ https://");
  return u.origin;
}

/** متغيرات التجربة تعمل فقط أثناء التطوير وليس في البرنامج المثبت */
function devEnv(name) {
  return app.isPackaged ? undefined : process.env[name];
}

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    /* أول تشغيل أو ملف تالف: نستخدم الافتراضي */
  }
  const merged = { ...DEFAULTS, ...saved, printers: { ...DEFAULTS.printers, ...(saved.printers || {}) } };
  try {
    merged.serverUrl = normalizeServerUrl(merged.serverUrl);
  } catch {
    merged.serverUrl = DEFAULT_SERVER;
  }
  return merged;
}

function get() {
  if (!cache) cache = load();
  // للتجربة والتطوير: رابط خادم مؤقت لا يُحفظ
  if (devEnv("TAJER_SERVER_URL")) return { ...cache, serverUrl: normalizeServerUrl(devEnv("TAJER_SERVER_URL")) };
  return cache;
}

function save(patch) {
  const base = cache || load();
  const next = { ...base, ...patch };
  if (patch.printers) next.printers = { ...base.printers, ...patch.printers };
  next.serverUrl = normalizeServerUrl(next.serverUrl);
  next.receiptCopies = Math.min(5, Math.max(1, Math.round(Number(next.receiptCopies) || 1)));
  next.zoom = Math.min(2, Math.max(0.5, Number(next.zoom) || 1));
  if (!["dashboard", "pos"].includes(next.startPage)) next.startPage = "dashboard";
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error("[settings] save failed", e);
  }
  return get();
}

module.exports = { get, save, normalizeServerUrl, devEnv, DEFAULT_SERVER };
