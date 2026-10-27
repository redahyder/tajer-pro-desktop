const params = new URLSearchParams(location.search);
const target = params.get("url") || "";
document.getElementById("reason").textContent = params.get("reason") || "";

function retry() {
  if (target) location.href = target;
}

// نفحص الاتصال كل 5 ثوانٍ ونرجع للنظام تلقائياً عند عودته
async function check() {
  try {
    await fetch(new URL("/robots.txt", target).toString(), { mode: "no-cors", cache: "no-store" });
    retry();
  } catch {
    document.getElementById("state").textContent = `آخر محاولة: ${new Date().toLocaleTimeString("ar-IQ")}`;
  }
}

document.getElementById("retry").addEventListener("click", retry);
window.addEventListener("online", retry);
setInterval(check, 5000);

document.getElementById("offline-pos").addEventListener("click", () => { try { const url = new URL(target); if (!["https:", "http:"].includes(url.protocol)) return; location.href = new URL("/admin/pos/offline", url.origin).href; } catch { /* invalid target */ } });
