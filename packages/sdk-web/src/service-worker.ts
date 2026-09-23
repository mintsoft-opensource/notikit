/**
 * Notikit 서비스워커 템플릿 — 사이트가 /notikit-sw.js 로 호스팅.
 *
 * FCM 백그라운드 메시지 수신 → 알림 표시 → 클릭 시 **클릭 보고 후** deep_link 로 이동.
 * (빌드 시 이 내용을 정적 파일로 복사해서 사용)
 *
 * 설치 시 워커에 설정을 주입한다(등록 URL 의 쿼리로 전달). NotikitWeb.register 가
 * 자동으로 붙이므로 직접 호스팅할 때도 경로만 맞추면 된다:
 *   /notikit-sw.js?base=...&key=...&fb_apiKey=...&fb_projectId=...&fb_senderId=...&fb_appId=...
 *
 * 클릭 보고에 쓸 FCM 토큰은 메인 스레드가 IndexedDB 에 남긴 것을 읽는다 —
 * 워커에서는 getToken 을 부를 수 없다.
 */
/** 워커가 불러올 firebase compat SDK 기본 버전. 앱의 firebase 메이저와 맞추는 것을 권장. */
export const DEFAULT_FIREBASE_SDK_VERSION = "12.0.0";

export const NOTIKIT_SERVICE_WORKER = `
var NOTIKIT = (function () {
  try {
    var q = new URL(self.location.href).searchParams;
    return {
      base: (q.get("base") || "").replace(/\\/$/, ""),
      key: q.get("key") || "",
      firebase: {
        apiKey: q.get("fb_apiKey") || "",
        projectId: q.get("fb_projectId") || "",
        messagingSenderId: q.get("fb_senderId") || "",
        appId: q.get("fb_appId") || ""
      },
      ver: q.get("fb_ver") || ""
    };
  } catch (e) {
    return { base: "", key: "", firebase: {}, ver: "" };
  }
})();

// compat SDK 버전은 앱이 쓰는 firebase 버전과 맞춰야 한다 — 어긋나면 메시징 동작이
// 미묘하게 달라진다. NotikitWeb 이 fb_ver 로 넘겨준다.
var NOTIKIT_FB_VER = NOTIKIT.ver || "${DEFAULT_FIREBASE_SDK_VERSION}";
importScripts("https://www.gstatic.com/firebasejs/" + NOTIKIT_FB_VER + "/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/" + NOTIKIT_FB_VER + "/firebase-messaging-compat.js");

if (NOTIKIT.firebase.appId) {
  firebase.initializeApp(NOTIKIT.firebase);
  firebase.messaging().onBackgroundMessage(function (payload) {
    // 서버는 웹에 **data-only** 로 보낸다. notification 이 실려 있으면 Firebase 가
    // 알림을 자동으로 띄운 뒤 이 콜백도 불러 알림이 두 번 뜬다.
    var data = payload.data || {};
    var n = payload.notification || {};
    // **반드시 반환한다.** Firebase 는 이 콜백의 반환값을 기다리는데, 반환하지 않으면
    // 표시가 끝나기 전에 push 이벤트 수명이 끝나 워커가 멈출 수 있다 — 탭이 모두
    // 닫힌 상태에서 알림이 통째로 사라진다.
    return self.registration.showNotification(data.title || n.title || "알림", {
      body: data.body || n.body || "",
      icon: data.icon || n.icon,
      image: data.image || n.image,
      data: {
        deep_link: data.deep_link || "/",
        // 클릭 보고에 필요한 발송 id. 서버가 data 에 실어 보낸다.
        notikit_log_id: data.notikit_log_id || null
      }
    });
  });
}

/** 메인 스레드가 등록 직후 남긴 FCM 토큰 — 워커에서는 getToken 을 쓸 수 없다. */
function notikitToken() {
  return new Promise(function (resolve) {
    var req = indexedDB.open("notikit", 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
    };
    req.onerror = function () { resolve(null); };
    req.onsuccess = function () {
      var db = req.result;
      try {
        var tx = db.transaction("kv", "readonly");
        var get = tx.objectStore("kv").get("fcmToken:" + NOTIKIT.key);
        get.onsuccess = function () { db.close(); resolve(get.result || null); };
        get.onerror = function () { db.close(); resolve(null); };
      } catch (e) {
        db.close();
        resolve(null);
      }
    };
  });
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  var url = d.deep_link || "/";

  // 클릭 보고는 창을 여는 것과 **병렬로** 진행한다. 보고를 기다렸다가 열면
  // 네트워크가 느릴 때 탭 반응이 눈에 띄게 늦어진다.
  var tasks = [clients.openWindow(url)];

  if (d.notikit_log_id && NOTIKIT.base && NOTIKIT.key) {
    tasks.push(
      notikitToken().then(function (token) {
        if (!token) return;
        // 등록 때와 **같은 FCM 토큰**이어야 서버가 이 기기를 찾는다.
        return fetch(NOTIKIT.base + "/api/v1/messages/click", {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": NOTIKIT.key },
          body: JSON.stringify({ log_id: d.notikit_log_id, token: token, destination: url })
        });
      }).catch(function () {
        // 보고 실패가 화면 이동을 막지 않는다 — 클릭 한 건보다 사용자 흐름이 우선
      })
    );
  }

  event.waitUntil(Promise.all(tasks));
});
`;
