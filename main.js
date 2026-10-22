// تاجر برو — تطبيق سطح المكتب
// نافذة على نفس النظام المنشور على الويب (نفس البيانات)، مع مزايا لا يوفرها المتصفح:
// طباعة الإيصالات مباشرة على الطابعة، اختيار طابعة لكل نوع، صفحة انقطاع الاتصال، والتشغيل مع ويندوز.
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, session, net, screen } = require("electron");
const config = require("./config");

const APP_TITLE = "تاجر برو";
const ICON = path.join(__dirname, "assets", "icon.png");
const PRINT_KINDS = ["receipt", "invoice", "label", "shipping", "shift"];
const EXTERNAL_PROTOCOLS = ["http:", "https:", "mailto:", "tel:", "whatsapp:"];
const SETTINGS_PAGE = path.join(__dirname, "pages", "settings.html");
const SETTINGS_URL = pathToFileURL(SETTINGS_PAGE).href;

let mainWindow = null;
let settingsWindow = null;

// نسخة واحدة فقط من البرنامج: فتحه مرة ثانية يُظهر النافذة الحالية
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/* ------------------------------ أدوات ------------------------------ */

function serverOrigin() {
  return new URL(config.get().serverUrl).origin;
}

function isServerUrl(url) {
  try {
    return new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
}

function startUrl() {
  const c = config.get();
  return `${c.serverUrl}${c.startPage === "pos" ? "/admin/pos" : "/admin"}`;
}

function openExternal(url) {
  try {
    if (EXTERNAL_PROTOCOLS.includes(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    /* رابط غير صالح */
  }
}

/** إعدادات صفحات النظام: معزولة عن Node، والـ preload يكشف واجهة الطباعة فقط لنطاق النظام */
function webPrefs() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    additionalArguments: [`--tajer-origin=${serverOrigin()}`, `--tajer-version=${app.getVersion()}`],
  };
}

/** هل الطلب قادم من صفحة تابعة لنطاق النظام؟ */
function fromServer(event) {
  const url = event.senderFrame?.url || event.sender.getURL();
  return isServerUrl(url);
}

/* ------------------------------ الطباعة ------------------------------ */

const MICRONS_PER_PX = 25400 / 96;
const VIRTUAL_PRINTER = /PDF|XPS|OneNote|Fax/i;

function printerFor(kind) {
  const c = config.get();
  if (kind === "shift") return c.printers.receipt || "";
  if (kind === "shipping") return c.printers.shipping || c.printers.label || "";
  return c.printers[kind] || "";
}

/**
 * مقاس الورق لكل نوع — بدونه يرسل Electron مقاس A4 لكل الطابعات:
 * الفاتورة A4، الإيصال بعرض الورق الحراري وطول المحتوى الفعلي، والملصق بمقاسه.
 */
async function pageSizeFor(contents, kind, page) {
  if (kind === "invoice") return { pageSize: "A4" };
  if (config.get().usePrinterPaper) return { usePrinterDefaultPageSize: true };
  if (kind === "label" || kind === "shipping") {
    if (page) return { pageSize: { width: Math.round(page.w * 1000), height: Math.round(page.h * 1000) } };
    return { usePrinterDefaultPageSize: true };
  }
  const m = await contents
    .executeJavaScript(
      `(() => {
        const el = document.querySelector("[data-print-root]") || document.body;
        return { mm: Number(el.getAttribute("data-paper-mm")) || 80, h: Math.ceil(el.getBoundingClientRect().height) };
      })()`,
      true,
    )
    .catch(() => ({ mm: 80, h: 0 }));
  // طول المحتوى + 5 ملم قبل القص
  const height = Math.max(50000, Math.round(m.h * MICRONS_PER_PX) + 5000);
  return { pageSize: { width: Math.round(m.mm * 1000), height } };
}

/** التأكد من الطابعة قبل الطباعة المباشرة (غير متصلة، أو الافتراضية طابعة وهمية مثل PDF) */
async function resolvePrinter(contents, kind) {
  const name = printerFor(kind);
  const printers = await contents.getPrintersAsync().catch(() => []);
  if (name) {
    if (!printers.some((p) => p.name === name)) {
      return { error: `الطابعة "${name}" غير متصلة — تأكد من تشغيلها أو اختر طابعة أخرى من إعدادات التطبيق` };
    }
    return { deviceName: name };
  }
  if (!config.get().silentPrint) return {};
  const def = printers.find((p) => p.isDefault);
  if (!def) return { error: "لا توجد طابعة مثبتة على هذا الجهاز", settings: true };
  if (kind !== "invoice" && VIRTUAL_PRINTER.test(def.name)) {
    return { error: "اختر الطابعة من إعدادات التطبيق (الطابعة الافتراضية في ويندوز ليست طابعة حقيقية)", settings: true };
  }
  return { deviceName: def.name };
}

function printOnce(contents, opts) {
  return new Promise((resolve) => {
    contents.print(opts, (ok, reason) => {
      if (ok) return resolve({ ok: true, error: null });
      if (reason === "Print job canceled") {
        // بدون نافذة الطباعة، "الإلغاء" يعني أن ويندوز رفض الأمر (طابعة مفصولة، ورق منتهي...)
        return resolve(opts.silent ? { ok: false, error: "ألغى ويندوز أمر الطباعة — تأكد أن الطابعة متصلة وفيها ورق" } : { ok: false, error: null, canceled: true });
      }
      if (reason === "Invalid deviceName provided") return resolve({ ok: false, error: "الطابعة المحددة غير موجودة — اخترها من جديد في إعدادات التطبيق" });
      resolve({ ok: false, error: reason || "تعذرت الطباعة" });
    });
  });
}

/** للتجربة الآلية فقط: حفظ الطباعة كملف PDF بنفس مقاس الورق بدل الطابعة */
async function printToPdfForTests(contents, kind, size) {
  const dir = config.devEnv("TAJER_PRINT_PDF_DIR");
  const opts = { printBackground: true };
  if (size.pageSize && typeof size.pageSize === "object") {
    opts.pageSize = { width: size.pageSize.width / 25400, height: size.pageSize.height / 25400 };
    opts.margins = { top: 0, bottom: 0, left: 0, right: 0 };
  } else if (size.pageSize) opts.pageSize = size.pageSize;
  else opts.preferCSSPageSize = true;
  const data = await contents.printToPDF(opts);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${Date.now()}.pdf`);
  fs.writeFileSync(file, data);
  return { ok: true, error: null, file, pageSize: size.pageSize ?? "printer-default" };
}

async function printContents(contents, kind, page) {
  const c = config.get();
  const size = await pageSizeFor(contents, kind, page);
  if (config.devEnv("TAJER_PRINT_PDF_DIR")) return printToPdfForTests(contents, kind, size);
  const printer = await resolvePrinter(contents, kind);
  if (printer.error) {
    if (printer.settings) openSettings();
    return { ok: false, error: printer.error };
  }
  const opts = {
    silent: !!c.silentPrint,
    printBackground: true,
    copies: 1,
    margins: { marginType: kind === "invoice" ? "default" : "none" },
    ...size,
  };
  if (printer.deviceName) opts.deviceName = printer.deviceName;
  // كل نسخة أمر طباعة مستقل حتى تقص الطابعة الحرارية بعد كل إيصال
  const copies = kind === "receipt" && opts.silent ? c.receiptCopies : 1;
  for (let i = 0; i < copies; i++) {
    const r = await printOnce(contents, opts);
    if (!r.ok) return r;
  }
  return { ok: true, error: null };
}

/** انتظار اكتمال رسم الصفحة (الباركود، رمز QR، الصور والخطوط) قبل الطباعة */
async function waitForRender(contents, requireReadyFlag) {
  const probe = `(() => (${requireReadyFlag ? "!!window.__tajerPrintReady" : "true"}) &&
    [...document.images].every((i) => i.complete) && (!document.fonts || document.fonts.status === "loaded"))()`;
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const ready = await contents.executeJavaScript(probe, true).catch(() => true);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 150));
}

/** الطباعة بالتسلسل حتى تخرج الإيصالات بترتيبها، مع تجاهل تكرار نفس الطلب أثناء طباعته */
let printChain = Promise.resolve();
const printing = new Set();
function enqueuePrint(key, task) {
  if (printing.has(key)) return Promise.resolve({ ok: false, error: null, canceled: true });
  printing.add(key);
  const run = printChain.then(task, task).finally(() => printing.delete(key));
  printChain = run.catch(() => {});
  return run;
}

/** طباعة صفحة من صفحات /admin/print/ في نافذة مخفية (بنفس جلسة الدخول) */
async function printUrl(url, kind) {
  const visible = !config.get().silentPrint;
  // بدون الطباعة المباشرة: نعرض الصفحة مع نافذة اختيار الطابعة ثم نغلقها
  const win = new BrowserWindow({
    show: visible,
    parent: visible && mainWindow ? mainWindow : undefined,
    modal: visible && !!mainWindow,
    width: 900,
    height: 1000,
    title: APP_TITLE,
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let status = 0;
  win.webContents.on("did-navigate", (_e, _url, code) => (status = code));
  let timer;
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("انتهت مهلة تحميل صفحة الطباعة — تحقق من الاتصال")), 20000);
      }),
    ]);
    if (win.isDestroyed()) return { ok: false, error: null, canceled: true };
    // إذا انتهت الجلسة يحوّل النظام لصفحة الدخول — لا نطبعها
    const landed = new URL(win.webContents.getURL());
    if (!isServerUrl(landed.href) || !landed.pathname.startsWith("/admin/print/")) {
      throw new Error("انتهت جلسة الدخول، سجّل الدخول ثم أعد المحاولة");
    }
    if (status >= 400) throw new Error(status === 404 ? "المستند غير موجود أو لا تملك صلاحية طباعته" : `خطأ من الخادم (${status})، حاول مرة أخرى`);
    await waitForRender(win.webContents, true);
    return await printContents(win.webContents, kind);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** مقاس الملصق القادم من الصفحة (بالملم) */
function validPage(p) {
  const w = Number(p?.w);
  const h = Number(p?.h);
  return w >= 10 && w <= 400 && h >= 10 && h <= 400 ? { w, h } : null;
}

ipcMain.handle("desktop:print-url", async (event, payload) => {
  if (!fromServer(event)) return { ok: false, error: "طلب غير مسموح" };
  const kind = PRINT_KINDS.includes(payload?.kind) ? payload.kind : "receipt";
  let target;
  try {
    target = new URL(String(payload?.url || ""), event.senderFrame?.url || event.sender.getURL());
  } catch {
    return { ok: false, error: "رابط طباعة غير صالح" };
  }
  if (target.origin !== serverOrigin() || !target.pathname.startsWith("/admin/print/")) return { ok: false, error: "رابط طباعة غير مسموح" };
  target.searchParams.delete("auto"); // حتى لا تطبع الصفحة نفسها مرة ثانية
  return enqueuePrint(`url:${target.pathname}`, () => printUrl(target.toString(), kind));
});

ipcMain.handle("desktop:print-page", async (event, payload) => {
  if (!fromServer(event)) return { ok: false, error: "طلب غير مسموح" };
  const kind = PRINT_KINDS.includes(payload?.kind) ? payload.kind : "invoice";
  const contents = event.sender;
  return enqueuePrint(`page:${contents.id}`, async () => {
    if (contents.isDestroyed()) return { ok: false, error: null, canceled: true };
    await waitForRender(contents, false);
    return printContents(contents, kind, validPage(payload?.page));
  });
});

ipcMain.on("desktop:open-settings", (event) => {
  if (fromServer(event)) openSettings();
});

/* ------------------------------ نافذة الإعدادات ------------------------------ */

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 880,
    minWidth: 560,
    minHeight: 520,
    minimizable: false,
    maximizable: false,
    title: `إعدادات ${APP_TITLE}`,
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenu(null);
  // نافذة الإعدادات تعرض صفحتها المحلية فقط
  settingsWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.loadFile(SETTINGS_PAGE);
  settingsWindow.on("closed", () => (settingsWindow = null));
}

function fromSettings(event) {
  return (
    !!settingsWindow &&
    !settingsWindow.isDestroyed() &&
    event.sender === settingsWindow.webContents &&
    (event.senderFrame?.url || "").split("?")[0] === SETTINGS_URL
  );
}

/** الرابط النهائي للنظام بعد التحويلات (مثلاً http → https أو بدون www → مع www) */
async function canonicalServer(origin) {
  try {
    const res = await net.fetch(`${origin}/admin/login`, { redirect: "follow", cache: "no-store" });
    return config.normalizeServerUrl(new URL(res.url).origin);
  } catch {
    return origin; // بدون اتصال: نحفظ الرابط كما كُتب
  }
}

ipcMain.handle("settings:get", async (event) => {
  if (!fromSettings(event)) return null;
  const printers = await event.sender.getPrintersAsync().catch(() => []);
  return {
    config: config.get(),
    printers: printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })),
    version: app.getVersion(),
    defaultServer: config.DEFAULT_SERVER,
  };
});

ipcMain.handle("settings:save", async (event, patch) => {
  if (!fromSettings(event)) return { ok: false, error: "طلب غير مسموح" };
  const before = config.get();
  let next;
  try {
    let serverUrl = config.normalizeServerUrl(String(patch.serverUrl ?? before.serverUrl));
    if (serverUrl !== before.serverUrl) serverUrl = await canonicalServer(serverUrl);
    next = config.save({
      serverUrl,
      startPage: patch.startPage,
      silentPrint: !!patch.silentPrint,
      printers: {
        receipt: String(patch.printers?.receipt ?? ""),
        invoice: String(patch.printers?.invoice ?? ""),
        label: String(patch.printers?.label ?? ""),
        shipping: String(patch.printers?.shipping ?? ""),
      },
      receiptCopies: patch.receiptCopies,
      usePrinterPaper: !!patch.usePrinterPaper,
      fullscreenOnStart: !!patch.fullscreenOnStart,
      openAtLogin: !!patch.openAtLogin,
    });
  } catch (e) {
    return { ok: false, error: e.message || "رابط النظام غير صالح" };
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    // النسخة المحمولة تعمل من مجلد مؤقت يُحذف عند الإغلاق، فنسجّل مسار ملفها الحقيقي
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath });
  }
  if (next.serverUrl !== before.serverUrl && mainWindow) {
    // تغيّر الخادم: نعيد إنشاء النافذة حتى تحمل الصلاحيات الجديدة
    mainWindow.destroy();
    createMainWindow();
  }
  return { ok: true };
});

ipcMain.handle("settings:test-print", async (event, kind) => {
  if (!fromSettings(event)) return { ok: false, error: "طلب غير مسموح" };
  const k = PRINT_KINDS.includes(kind) ? kind : "receipt";
  const width = k === "invoice" ? "180mm" : k === "label" ? "46mm" : k === "shipping" ? "90mm" : "72mm";
  const html = `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><style>
    @page { margin: 0 } body { margin: 0; font-family: Tahoma, Arial, sans-serif; text-align: center }
    main { width: ${width}; margin: 0 auto; padding: 3mm 0 } h1 { font-size: 18px; margin: 4px 0 } p { font-size: 13px; margin: 4px 0 }
  </style><main data-print-root data-paper-mm="80"><h1>${APP_TITLE}</h1><p>طباعة تجريبية</p><p>${new Date().toLocaleString("ar-IQ")}</p><p>✓ الطابعة تعمل بشكل صحيح</p></main></html>`;
  return enqueuePrint(`test:${k}`, async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await printContents(win.webContents, k, k === "label" ? { w: 50, h: 25 } : k === "shipping" ? { w: 100, h: 150 } : null);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
});

/* ------------------------------ النافذة الرئيسية ------------------------------ */

function showOffline(failedUrl, reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, "pages", "offline.html"), {
    query: { url: failedUrl && isServerUrl(failedUrl) ? failedUrl : startUrl(), reason: reason || "" },
  });
}

/** موضع النافذة المحفوظ، إذا كان ما زال ظاهراً على إحدى الشاشات المتصلة (قد تُفصل شاشة ثانية) */
function visibleBounds(b) {
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 200 && h >= 100;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

function createMainWindow() {
  const c = config.get();
  const b = visibleBounds(c.bounds);
  mainWindow = new BrowserWindow({
    width: b?.width ?? 1366,
    height: b?.height ?? 820,
    x: b?.x,
    y: b?.y,
    minWidth: 1000,
    minHeight: 640,
    title: APP_TITLE,
    icon: ICON,
    show: false,
    backgroundColor: "#f8fafc",
    webPreferences: webPrefs(),
  });
  const win = mainWindow;

  win.once("ready-to-show", () => {
    if (c.maximized) win.maximize();
    if (c.fullscreenOnStart) win.setFullScreen(true);
    win.show();
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 = تم إلغاء التحميل (تنقّل جديد)، ليس انقطاعاً. وفشل صفحة محلية لا يعيد فتح صفحة الانقطاع (حتى لا تتكرر)
    if (!isMainFrame || code === -3 || String(url).startsWith("file:")) return;
    showOffline(url, desc);
  });

  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(config.get().zoom);
  });

  // الحفاظ على عنوان ثابت للنافذة بدل عنوان كل صفحة
  win.on("page-title-updated", (e, title) => {
    e.preventDefault();
    win.setTitle(title && isServerUrl(win.webContents.getURL()) ? `${title} — ${APP_TITLE}` : APP_TITLE);
  });

  win.on("close", () => {
    try {
      config.save({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    } catch {
      /* تجاهل */
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadURL(startUrl());
}

/** قيود التنقل لكل الصفحات: النظام يبقى داخل التطبيق، وأي رابط خارجي يفتح في المتصفح */
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isServerUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  // التحويلات من الخادم (3xx) لا تمر عبر will-navigate
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || isServerUrl(event.url)) return;
    event.preventDefault();
    openExternal(event.url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isServerUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 900,
          title: APP_TITLE,
          icon: ICON,
          autoHideMenuBar: true,
          backgroundColor: "#ffffff",
          webPreferences: webPrefs(),
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });
});

/* ------------------------------ القائمة ------------------------------ */

function go(pathname) {
  if (!mainWindow) return createMainWindow();
  mainWindow.loadURL(`${config.get().serverUrl}${pathname}`);
}

function zoomBy(delta) {
  if (!mainWindow) return;
  const z = delta === 0 ? 1 : Math.round((mainWindow.webContents.getZoomFactor() + delta) * 10) / 10;
  const saved = config.save({ zoom: z });
  mainWindow.webContents.setZoomFactor(saved.zoom);
}

function buildMenu() {
  const template = [
    {
      label: "تاجر برو",
      submenu: [
        { label: "لوحة التحكم", accelerator: "CmdOrCtrl+1", click: () => go("/admin") },
        { label: "نقطة البيع (الكاشير)", accelerator: "CmdOrCtrl+2", click: () => go("/admin/pos") },
        { label: "المتجر الإلكتروني", accelerator: "CmdOrCtrl+3", click: () => go("/") },
        { type: "separator" },
        { label: "إعدادات التطبيق والطابعات", accelerator: "CmdOrCtrl+,", click: openSettings },
        { type: "separator" },
        { label: "خروج", role: "quit" },
      ],
    },
    {
      label: "تحرير",
      submenu: [
        { label: "تراجع", role: "undo" },
        { label: "إعادة", role: "redo" },
        { type: "separator" },
        { label: "قص", role: "cut" },
        { label: "نسخ", role: "copy" },
        { label: "لصق", role: "paste" },
        { label: "تحديد الكل", role: "selectAll" },
      ],
    },
    {
      label: "عرض",
      submenu: [
        { label: "تحديث الصفحة", accelerator: "F5", click: () => mainWindow?.webContents.reload() },
        { label: "رجوع", accelerator: "Alt+Left", click: () => mainWindow?.webContents.navigationHistory.goBack() },
        { type: "separator" },
        { label: "تكبير", accelerator: "CmdOrCtrl+=", click: () => zoomBy(0.1) },
        { label: "تصغير", accelerator: "CmdOrCtrl+-", click: () => zoomBy(-0.1) },
        { label: "الحجم الطبيعي", accelerator: "CmdOrCtrl+0", click: () => zoomBy(0) },
        { type: "separator" },
        { label: "ملء الشاشة", role: "togglefullscreen", accelerator: "F11" },
        // أدوات المطور أثناء التطوير فقط
        ...(app.isPackaged ? [] : [{ label: "أدوات المطور", role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" }]),
      ],
    },
    {
      label: "مساعدة",
      submenu: [
        {
          label: "حول تاجر برو",
          click: () =>
            dialog.showMessageBox(mainWindow ?? undefined, {
              type: "info",
              title: APP_TITLE,
              message: `${APP_TITLE} — تطبيق سطح المكتب`,
              detail: `الإصدار ${app.getVersion()}\nالخادم: ${config.get().serverUrl}\n\nالتطبيق يعرض نفس النظام المنشور على الويب وبنفس البيانات، مع طباعة مباشرة على طابعات الإيصالات والملصقات.`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ التشغيل ------------------------------ */

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  const ses = session.defaultSession;
  // يعرّف النظام أنه يعمل داخل تطبيق سطح المكتب
  ses.setUserAgent(`${ses.getUserAgent()} TajerDesktop/${app.getVersion()}`);
  // لا صلاحيات خاصة (كاميرا، موقع، إشعارات...) إلا ما يحتاجه النظام
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "fullscreen"]);
  ses.setPermissionRequestHandler((contents, permission, cb) => cb(allowed.has(permission) && isServerUrl(contents.getURL())));
  ses.setPermissionCheckHandler((contents, permission) => allowed.has(permission) && !!contents && isServerUrl(contents.getURL()));

  buildMenu();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
