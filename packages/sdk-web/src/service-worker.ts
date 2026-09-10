/**
 * Notikit 서비스워커 템플릿 — 사이트가 /notikit-sw.js 로 호스팅.
 * push 이벤트 수신 → 알림 표시 → 클릭 시 **클릭 보고 후** deep_link 로 이동.
 * (빌드 시 이 내용을 정적 파일로 복사해서 사용)
 *
 * 웹은 서비스워커를 SDK 가 소유하므로 탭 이벤트를 직접 잡을 수 있다. 네이티브는
 * 델리게이트/Intent 를 앱이 쥐고 있어 handleNotificationOpen 을 앱이 불러줘야 한다.
 *
 * 설치 시 워커에 설정을 주입한다(등록 URL 의 쿼리로 전달):
 *   navigator.serviceWorker.register('/notikit-sw.js?base=...&key=...')
 */
export const NOTIKIT_SERVICE_WORKER = `
var NOTIKIT = (function () {
  try {
    var q = new URL(self.location.href).searchParams;
    return { base: (q.get("base") || "").replace(/\\/$/, ""), key: q.get("key") || "" };
  } catch (e) {
    return { base: "", key: "" };
  }
})();

self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  var data = payload.data || {};
  var title = payload.title || "알림";
  var options = {
    body: payload.body || "",
    icon: payload.icon,
    data: {
      deep_link: data.deep_link || payload.deep_link || "/",
      // 클릭 보고에 필요한 발송 id. 서버가 data 에 실어 보낸다.
      notikit_log_id: data.notikit_log_id || null
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  var url = d.deep_link || "/";

  // 클릭 보고는 창을 여는 것과 **병렬로** 진행한다. 보고를 기다렸다가 열면
  // 네트워크가 느릴 때 탭 반응이 눈에 띄게 늦어진다.
  var tasks = [clients.openWindow(url)];

  if (d.notikit_log_id && NOTIKIT.base && NOTIKIT.key) {
    tasks.push(
      self.registration.pushManager.getSubscription().then(function (sub) {
        if (!sub) return;
        // 등록 때와 **정확히 같은 문자열**이어야 서버가 이 기기를 찾는다.
        // sdk-web 은 구독 객체 전체를 JSON.stringify 해서 토큰으로 쓴다 —
        // endpoint 만 보내면 매칭에 실패해 클릭이 조용히 사라진다.
        return fetch(NOTIKIT.base + "/api/v1/messages/click", {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": NOTIKIT.key },
          body: JSON.stringify({ log_id: d.notikit_log_id, token: JSON.stringify(sub), destination: url })
        });
      }).catch(function () {
        // 보고 실패가 화면 이동을 막지 않는다 — 클릭 한 건보다 사용자 흐름이 우선
      })
    );
  }

  event.waitUntil(Promise.all(tasks));
});
`;
