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

      await notikit.registerDevice(token: 't1', platform: 'android', userId: 'u1', identityHash: 'h');

      expect(captured.headers['api-key'], 'nk_test');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['user_id'], 'u1');
      expect(body.containsKey('external_id'), isFalse);
      expect(body['identity_hash'], 'h');
      expect(body.containsKey('locale'), isFalse); // null 제거
    });

    test('throws NotikitException on failure', () async {
      final mock = MockClient((req) async =>
          http.Response(jsonEncode({'success': false, 'data': null, 'error': 'Unauthorized'}), 401));
      final notikit = Notikit(baseUrl: 'https://push.test', apiKey: 'nk', client: mock);

      expect(() => notikit.identify(userId: 'u1'), throwsA(isA<NotikitException>()));
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

    test('identify sends name and omits it when not given', () async {
      final bodies = <Map<String, dynamic>>[];
      final client = MockClient((req) async {
        bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response(jsonEncode({'success': true, 'data': {'user': {}}, 'error': null}), 200);
      });
      final n = Notikit(baseUrl: 'https://push.test', apiKey: 'nk', client: client);
      await n.identify(userId: 'u1', name: '김민지');
      await n.identify(userId: 'u1');
      expect(bodies[0]['name'], '김민지');
      expect(bodies[1].containsKey('name'), isFalse);
    });

    group('deprecated externalId', () {
      late List<Map<String, dynamic>> bodies;
      late Notikit n;
      setUp(() {
        bodies = [];
        n = Notikit(
          baseUrl: 'https://push.test',
          apiKey: 'nk',
          client: MockClient((req) async {
            bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
            return http.Response(jsonEncode({'success': true, 'data': {}, 'error': null}), 200);
          }),
        );
      });

      test('registerDevice still binds, sent as user_id', () async {
        // ignore: deprecated_member_use_from_same_package
        await n.registerDevice(token: 't1', platform: 'ios', externalId: 'u1', identityHash: 'h');
        expect(bodies.single['user_id'], 'u1');
        expect(bodies.single['identity_hash'], 'h');
        expect(bodies.single.containsKey('external_id'), isFalse);
      });

      test('identify still works, sent as user_id', () async {
        // ignore: deprecated_member_use_from_same_package
        await n.identify(externalId: 'u1');
        expect(bodies.single['user_id'], 'u1');
        expect(bodies.single.containsKey('external_id'), isFalse);
      });

      test('userId wins over externalId', () async {
        // ignore: deprecated_member_use_from_same_package
        await n.identify(userId: 'new', externalId: 'old');
        expect(bodies.single['user_id'], 'new');
      });
    });

    test('identify without any user id throws ArgumentError', () {
      final n = Notikit(baseUrl: 'https://push.test', apiKey: 'nk', client: MockClient((_) async => http.Response('{}', 200)));
      expect(() => n.identify(), throwsArgumentError);
    });

    test('registerDevice without user id omits user_id and identity_hash', () async {
      late Map<String, dynamic> body;
      final n = Notikit(
        baseUrl: 'https://push.test',
        apiKey: 'nk',
        client: MockClient((req) async {
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'success': true, 'data': {}, 'error': null}), 200);
        }),
      );
      await n.registerDevice(token: 't1', platform: 'android', identityHash: 'h');
      expect(body.containsKey('user_id'), isFalse);
      expect(body.containsKey('identity_hash'), isFalse);
    });

    test('unbindDevice sends explicit user_id null', () async {
      late Map<String, dynamic> body;
      final n = Notikit(
        baseUrl: 'https://push.test',
        apiKey: 'nk',
        client: MockClient((req) async {
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'success': true, 'data': {}, 'error': null}), 200);
        }),
      );
      await n.unbindDevice(token: 't1', platform: 'android', identityHash: 'h');
      expect(body.containsKey('user_id'), isTrue);
      expect(body['user_id'], isNull);
      expect(body.containsKey('external_id'), isFalse);
      expect(body['identity_hash'], 'h');
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
