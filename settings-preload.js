// واجهة صفحة إعدادات التطبيق (صفحة محلية داخل التطبيق)
const { contextBridge, ipcRenderer } = require("electron");

if (window.location.protocol === "file:") {
  contextBridge.exposeInMainWorld("settingsApi", {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (data) => ipcRenderer.invoke("settings:save", data),
    testPrint: (kind) => ipcRenderer.invoke("settings:test-print", kind),
  });
}
