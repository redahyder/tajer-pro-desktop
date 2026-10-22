// يكشف واجهة صغيرة لصفحات النظام فقط (لا وصول لـ Node أو الملفات)
const { contextBridge, ipcRenderer } = require("electron");

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

const allowedOrigin = arg("tajer-origin");

if (allowedOrigin && window.location.origin === allowedOrigin) {
  contextBridge.exposeInMainWorld("tajerDesktop", {
    isDesktop: true,
    version: arg("tajer-version"),
    /** طباعة صفحة من صفحات /admin/print/ مباشرة على الطابعة المحددة لهذا النوع */
    printUrl: (url, kind) => ipcRenderer.invoke("desktop:print-url", { url: String(url), kind: String(kind || "receipt") }),
    /** طباعة الصفحة الحالية — page: مقاس الملصق بالملم { w, h } */
    printPage: (kind, page) =>
      ipcRenderer.invoke("desktop:print-page", { kind: String(kind || "invoice"), page: page ? { w: Number(page.w), h: Number(page.h) } : null }),
    /** فتح إعدادات التطبيق والطابعات */
    openSettings: () => ipcRenderer.send("desktop:open-settings"),
  });
}
