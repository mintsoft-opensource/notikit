/// Notikit Flutter SDK — 유저 중심 푸시 등록/식별.
///
/// FCM 토큰은 firebase_messaging 플러그인이 획득하고, 이 SDK 가 서버에 등록한다.
library notikit;

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class NotikitException implements Exception {
  final String message;
  final int status;
  NotikitException(this.message, this.status);
  @override
  String toString() => 'NotikitException($status): $message';
}

class Notikit {
  final String baseUrl;

  /// 공개 api-key 만 사용 (발송용 api-secret 은 클라이언트에 넣지 않음).
  final String apiKey;
  final http.Client _client;
  /// 우리가 만든 클라이언트만 닫는다 — 주입받은 것은 소유자가 따로 있다
  final bool _ownsClient;

  Notikit({
    required String baseUrl,
    required this.apiKey,
    http.Client? client,
  })  : baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        _client = client ?? http.Client(),
        _ownsClient = client == null;

  /// 연결 풀을 해제한다. 직접 만든 클라이언트가 아니면 아무것도 하지 않는다.
  /// 없으면 SDK 를 버려도 내부 클라이언트의 연결이 남는다.
  void close() {
    if (_ownsClient) _client.close();
  }

  /// 미지정(null) 필드를 제거하고 전송 — 서버가 기존 값을 유지하게 한다.
  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) {
    return _postRaw(path, Map<String, dynamic>.from(body)..removeWhere((_, v) => v == null));
  }

  /// null 을 그대로 실어 전송 — 명시적 해제(external_id: null)와 미지정을 구분해야 할 때.
  Future<Map<String, dynamic>> _postRaw(String path, Map<String, dynamic> body) async {
    final headers = <String, String>{
      'content-type': 'application/json',
      'api-key': apiKey,
    };

    final res = await _client.post(Uri.parse('$baseUrl$path'), headers: headers, body: jsonEncode(body));

    Map<String, dynamic> json;
    try {
      json = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      throw NotikitException('Invalid response', res.statusCode);
    }
    // `as String?` 로 단정하면 안 된다 — 게이트웨이나 프록시가 error 를 객체로 주면
    // NotikitException 대신 raw TypeError 가 튀어 방어적 파싱이 무의미해진다.
    if (res.statusCode >= 400 || json['success'] != true) {
      final err = json['error'];
      throw NotikitException(err is String ? err : 'Request failed', res.statusCode);
    }
    final data = json['data'];
    return data is Map<String, dynamic> ? data : <String, dynamic>{};
  }

  /// 디바이스/토큰 등록 (external_id 바인딩 시 identityHash 필요)
  Future<Map<String, dynamic>> registerDevice({
    required String token,
    required String platform,
    String? externalId,
    String? identityHash,
    String? locale,
    String? timezone,
  }) {
    return _post('/api/v1/devices', {
      'token': token,
      'platform': platform,
      'external_id': externalId,
      'identity_hash': externalId != null ? identityHash : null,
      'locale': locale,
      'timezone': timezone,
    });
  }

  /// 유저 식별
  Future<Map<String, dynamic>> identify({
    required String externalId,
    String? identityHash,
    Map<String, dynamic>? attributes,
  }) {
    return _post('/api/v1/users/identify', {
      'external_id': externalId,
      'identity_hash': identityHash,
      'attributes': attributes,
    });
  }

  /// 앱 열림 보고 — 접속 통계(DAU/WAU/MAU)의 원천.
  ///
  /// registerDevice 는 무거우므로 앱을 열 때마다는 이쪽을 쓴다.
  Future<Map<String, dynamic>> ping(String token) {
    return _post('/api/v1/devices/ping', {'token': token});
  }

  /// 토픽 구독
  Future<Map<String, dynamic>> subscribe(String topic, String token) {
    return _post('/api/v1/topics/subscribe', {'topic': topic, 'token': token});
  }

  /// 푸시 토큰 교체 (FirebaseMessaging.onTokenRefresh).
  ///
  /// 새 토큰으로 registerDevice 를 부르면 **행이 하나 더 생긴다** — 옛 행이 유저
  /// 바인딩을 유지한 채 활성으로 남아 같은 사람에게 중복 발송된다. 서버가 기존 행의
  /// 토큰을 제자리 갱신하게 해 기기 id·토픽 구독·클릭 이력을 보존한다.
  Future<Map<String, dynamic>> rotateToken({
    required String oldToken,
    required String newToken,
    String? identityHash,
  }) {
    return _post('/api/v1/devices/rotate', {
      'old_token': oldToken,
      'new_token': newToken,
      'identity_hash': identityHash,
    });
  }

  /// 디바이스 바인딩 해제 (로그아웃/계정전환).
  ///
  /// 해제하지 않으면 이후 클릭이 이전 계정에 계속 귀속된다.
  /// `_post` 가 null 값을 제거하므로 명시적 해제는 별도 경로로 보낸다.
  Future<Map<String, dynamic>> unbindDevice({
    required String token,
    required String platform,
    String? identityHash,
  }) {
    return _postRaw('/api/v1/devices', {
      'token': token,
      'platform': platform,
      // 서버가 현재 바인딩된 유저의 해시를 검증한다 — 남의 토큰으로 해제하는 것을 막는다
      if (identityHash != null) 'identity_hash': identityHash,
      'external_id': null,
    });
  }

  /// 푸시 클릭(알림 탭) 보고.
  ///
  /// 유저는 서버가 토큰의 바인딩에서 해석하므로 externalId 를 보내지 않는다.
  Future<Map<String, dynamic>> reportClick({
    required String logId,
    required String token,
    String? destination,
  }) {
    return _post('/api/v1/messages/click', {
      'log_id': logId,
      'token': token,
      'destination': destination,
    });
  }

  /// 알림 탭 처리 — `RemoteMessage.data` 를 그대로 넘기면 된다.
  ///
  /// 탭 스트림(`FirebaseMessaging.onMessageOpenedApp`, `getInitialMessage`)은 앱이
  /// 구독하는 것이라 SDK 가 가로챌 수 없다. 앱에서 이렇게 연결한다:
  ///
  ///     FirebaseMessaging.onMessageOpenedApp.listen((m) {
  ///       notikit.handleNotificationOpen(data: m.data, token: token);
  ///     });
  ///     final initial = await FirebaseMessaging.instance.getInitialMessage();
  ///     if (initial != null) await notikit.handleNotificationOpen(data: initial.data, token: token);
  ///
  /// notikit 이 보낸 알림이 아니면 아무 것도 하지 않는다 — 다른 경로의 알림까지
  /// 클릭으로 세면 클릭률이 부풀려진다.
  Future<bool> handleNotificationOpen({
    required Map<String, dynamic>? data,
    required String token,
    String? destination,
  }) async {
    final logId = logIdFromPayload(data);
    if (logId == null) return false;
    await reportClick(logId: logId, token: token, destination: destination);
    return true;
  }

  /// 알림 탭 스트림을 붙여 클릭 보고를 자동화한다.
  ///
  /// firebase_messaging 에 의존하지 않으려고 스트림과 초기 메시지를 **인자로 받는다**.
  /// 앱에서 한 번만 연결하면 이후 탭은 자동으로 보고된다:
  ///
  ///     final sub = notikit.attachTapStream(
  ///       onOpened: FirebaseMessaging.onMessageOpenedApp.map((m) => m.data),
  ///       initialMessage: (await FirebaseMessaging.instance.getInitialMessage())?.data,
  ///       token: () => currentToken,
  ///     );
  ///
  /// 토큰은 갱신될 수 있어 값이 아니라 콜백으로 받는다 — 값으로 받으면 갱신 후
  /// 클릭이 서버에서 매칭되지 않는다.
  ///
  /// 반환한 구독은 앱 종료 시 취소한다.
  StreamSubscription<Map<String, dynamic>> attachTapStream({
    required Stream<Map<String, dynamic>> onOpened,
    required String? Function() token,
    Map<String, dynamic>? initialMessage,
  }) {
    // 앱이 알림 탭으로 콜드 스타트된 경우 — 스트림에는 오지 않으므로 따로 처리한다
    if (initialMessage != null) {
      _reportTap(initialMessage, token);
    }

    return onOpened.listen(
      (data) => _reportTap(data, token),
      // onError 가 없으면 스트림 자체의 에러가 uncaught 로 샌다.
      // 탭 보고 실패가 앱을 죽이면 안 된다.
      onError: (_) {},
    );
  }

  /// 이미 보고한 발송 — initState/hot reload 로 attachTapStream 이 두 번 불리면
  /// 구독이 둘 다 살아 탭당 2회, initialMessage 도 다시 보고된다. 서버가 (발송, 기기)
  /// 유니크로 막아 통계는 안 틀리지만 불필요한 요청이 그대로 나간다.
  final Set<String> _reportedLogIds = {};

  void _reportTap(Map<String, dynamic> data, String? Function() token) {
    final logId = logIdFromPayload(data);
    if (logId == null || !_reportedLogIds.add(logId)) return;
    final tok = token();
    if (tok == null) {
      _reportedLogIds.remove(logId); // 토큰이 생기면 다시 시도할 수 있게 되돌린다
      return;
    }
    // 보고 실패가 앱 흐름을 막지 않는다
    unawaited(handleNotificationOpen(data: data, token: tok).catchError((_) => false));
  }

  /// 푸시 페이로드에서 notikit 이 예약해 쓰는 data 키
  static const String logIdKey = 'notikit_log_id';

  /// FCM data 에서 발송 id 추출 — 없으면 notikit 발송이 아니다
  static String? logIdFromPayload(Map<String, dynamic>? data) {
    final v = data?[logIdKey];
    return (v is String && v.isNotEmpty) ? v : null;
  }
}
