import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';
import 'package:notikit/notikit.dart';

void main() {
  group('Notikit', () {
    test('registerDevice sends api-key and mapped payload', () async {
      late http.Request captured;
      final mock = MockClient((req) async {
        captured = req;
        return http.Response(jsonEncode({'success': true, 'data': {'device': {}}, 'error': null}), 201);
      });
      final notikit = Notikit(baseUrl: 'https://push.test/', apiKey: 'nk_test', client: mock);

      await notikit.registerDevice(token: 't1', platform: 'android', externalId: 'u1', identityHash: 'h');

      expect(captured.headers['api-key'], 'nk_test');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['external_id'], 'u1');
      expect(body['identity_hash'], 'h');
      expect(body.containsKey('locale'), isFalse); // null 제거
    });

    test('throws NotikitException on failure', () async {
      final mock = MockClient((req) async =>
          http.Response(jsonEncode({'success': false, 'data': null, 'error': 'Unauthorized'}), 401));
      final notikit = Notikit(baseUrl: 'https://push.test', apiKey: 'nk', client: mock);

      expect(() => notikit.identify(externalId: 'u1'), throwsA(isA<NotikitException>()));
    });

    test('omits api-secret when not provided', () async {
      late http.Request captured;
      final mock = MockClient((req) async {
        captured = req;
        return http.Response(jsonEncode({'success': true, 'data': {}, 'error': null}), 200);
      });
      final notikit = Notikit(baseUrl: 'https://push.test', apiKey: 'nk', client: mock);
      await notikit.subscribe('news', 't1');
      expect(captured.headers.containsKey('api-secret'), isFalse);
    });

    test('customDataFromPayload skips notikit and FCM keys', () {
      final payload = <String, dynamic>{
        'notikit_log_id': 'log1',
        'deep_link': 'myapp://orders',
        'google.message_id': 'x',
        'gcm.n.e': '1',
        'from': '123',
        'order_id': 'A-1',
        'screen': 'order',
      };
      expect(Notikit.customDataFromPayload(payload), {'order_id': 'A-1', 'screen': 'order'});
      expect(Notikit.deepLinkFromPayload(payload), 'myapp://orders');
      expect(Notikit.customDataFromPayload(null), isEmpty);
    });
  });
}
