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
