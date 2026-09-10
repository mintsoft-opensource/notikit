/// Notikit Flutter SDK — 유저 중심 푸시 등록/식별.
///
/// FCM 토큰은 firebase_messaging 플러그인이 획득하고, 이 SDK 가 서버에 등록한다.
library notikit;

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

  Notikit({
    required String baseUrl,
    required this.apiKey,
    http.Client? client,
  })  : baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        _client = client ?? http.Client();

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
    if (res.statusCode >= 400 || json['success'] != true) {
      throw NotikitException((json['error'] as String?) ?? 'Request failed', res.statusCode);
    }
    return (json['data'] as Map<String, dynamic>?) ?? <String, dynamic>{};
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

  /// 토픽 구독
  Future<Map<String, dynamic>> subscribe(String topic, String token) {
    return _post('/api/v1/topics/subscribe', {'topic': topic, 'token': token});
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

  /// 푸시 페이로드에서 notikit 이 예약해 쓰는 data 키
  static const String logIdKey = 'notikit_log_id';

  /// FCM data 에서 발송 id 추출 — 없으면 notikit 발송이 아니다
  static String? logIdFromPayload(Map<String, dynamic>? data) {
    final v = data?[logIdKey];
    return (v is String && v.isNotEmpty) ? v : null;
  }
}
