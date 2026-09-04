/**
 * Notikit 서비스워커 템플릿 — 사이트가 /notikit-sw.js 로 호스팅.
 * push 이벤트 수신 → 알림 표시 → 클릭 시 deep_link 로 이동.
 * (빌드 시 이 내용을 정적 파일로 복사해서 사용)
 */
export const NOTIKIT_SERVICE_WORKER = `
self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  var title = payload.title || "알림";
  var options = {
    body: payload.body || "",
    icon: payload.icon,
    data: { deep_link: (payload.data && payload.data.deep_link) || payload.deep_link || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.deep_link) || "/";
  event.waitUntil(clients.openWindow(url));
});
`;
