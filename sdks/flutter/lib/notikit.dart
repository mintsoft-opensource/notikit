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

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final headers = <String, String>{
      'content-type': 'application/json',
      'api-key': apiKey,
    };

    body.removeWhere((_, v) => v == null);
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
}
